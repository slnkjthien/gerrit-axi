/**
 * CLI entry point: dispatch, and the one place errors turn into output.
 *
 * src/core/ raises typed errors with machine-readable codes and optional
 * `remedy` text; deciding how those look on a terminal, and what exit code they
 * map to, is this layer's job.
 */

import { readFile } from 'node:fs/promises';

import { AuthError, ConfigError, GerritError, TransportError } from '../core/errors.js';
import { createSession } from '../core/session.js';
import { AUTH_USAGE, runAuth } from './commands/auth.js';
import { COMMENTS_FLAGS, COMMENTS_USAGE, runComments } from './commands/comments.js';
import { SHOW_FLAGS, SHOW_USAGE, runShow } from './commands/show.js';
import { STATUS_FLAGS, STATUS_USAGE, runStatus } from './commands/status.js';
import { UsageError, parseArgs } from './args.js';
import { makeColorizer, terminalWidth } from './render.js';

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  config: 3,
  auth: 4,
  transport: 5,
};

const USAGE = `gerrit - read-only Gerrit status and review comments

usage: gerrit <command> [options]

commands, and the options each one takes:
  status                      changes awaiting your attention ("your turn")
  status mine                 your open changes
  status <change>...          specific change numbers
  status --query '<query>'    an arbitrary Gerrit query
      --labels                one column per label the server reports
      --patch-set             add the current patch set number and revision
      --limit <n>             maximum changes to fetch (default 100)
  show <change>...            one change in full: current patch set and revision,
                              dependencies, every vote with who cast it and when,
                              and the cover messages (build results and their URLs)
      --messages <n|all>      how many cover messages to show (default 10)
  comments <change>           inline review comments
      --bots | --humans       only / never machine-generated
  auth login|status|logout    manage the stored Gerrit auth token
      --stdin                 read the token from stdin ('auth login')

global options:
  --host <h>      override the resolved Gerrit host
  --user <u>      override the resolved Gerrit username
  --port <p>      override the Gerrit SSH port
  --rest-base <u> override the REST base URL (e.g. https://gerrit.example.com)
  --no-color      disable colour
  -h, --help      show this help
  -V, --version   print the version

Host, port, user and project are resolved from the 'origin' git remote of the
current directory first, then from GERRIT_HOST / GERRIT_USER / GERRIT_PORT, then
from the config file. There is no built-in default host.

v0.1 is read-only: it never votes, comments, pushes, or otherwise mutates Gerrit.`;

/**
 * @param {string[]} argv          argv without node and script
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdout?: NodeJS.WriteStream,
 *          stderr?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream,
 *          runner?: import('../core/exec.js').Runner, fetchImpl?: typeof fetch}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    runner,
    fetchImpl,
  } = io;

  const out = (/** @type {string} */ line = '') => { stdout.write(`${line}\n`); };
  const err = (/** @type {string} */ line = '') => { stderr.write(`${line}\n`); };

  const [command, ...rest] = argv;

  // Help and version must work with no config and no network.
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    out(await packageVersion());
    return EXIT.ok;
  }

  const flagSpec = command === 'status'
    ? STATUS_FLAGS
    : command === 'show'
      ? SHOW_FLAGS
      : command === 'comments'
        ? COMMENTS_FLAGS
        : command === 'auth'
          ? { withValue: new Set(), boolean: new Set(['--stdin']) }
          : {};

  let colorize = makeColorizer({ env, isTTY: stdout.isTTY });

  try {
    const args = parseArgs(rest, flagSpec);
    colorize = makeColorizer({ env, isTTY: stdout.isTTY, forceOff: args.noColor });

    if (args.help) {
      out(usageFor(command));
      return EXIT.ok;
    }
    if (args.version) {
      out(await packageVersion());
      return EXIT.ok;
    }

    const session = await createSession({
      overrides: args.overrides,
      cwd,
      env,
      runner,
      fetchImpl,
    });
    // Width comes from the stream we were handed, not from the real process, so a
    // caller supplying its own stdout gets layout that matches it.
    const ctx = { session, args, out, err, colorize, stdin, stderr, width: terminalWidth(stdout) };

    switch (command) {
      case 'status':
        return await runStatus(ctx);
      case 'show':
        return await runShow(ctx);
      case 'comments':
        return await runComments(ctx);
      case 'auth':
        return await runAuth(ctx);
      default:
        err(`unknown command: ${command}`);
        err('');
        err(USAGE);
        return EXIT.usage;
    }
  } catch (error) {
    return reportError(error, { err, colorize });
  }
}

/**
 * @param {string} command
 * @returns {string}
 */
function usageFor(command) {
  switch (command) {
    case 'status': return STATUS_USAGE;
    case 'show': return SHOW_USAGE;
    case 'comments': return COMMENTS_USAGE;
    case 'auth': return AUTH_USAGE;
    default: return USAGE;
  }
}

/**
 * Turn an error into terminal output and an exit code. A token can never appear
 * here: core never puts one in a message, and nothing in this function inspects a
 * credential.
 *
 * @param {unknown} error
 * @param {{err: (line?: string) => void, colorize: (code: string, text: string) => string}} io
 * @returns {number}
 */
function reportError(error, { err, colorize }) {
  if (error instanceof UsageError) {
    err(`${colorize('red', 'error')}: ${error.message}`);
    return EXIT.usage;
  }
  if (error instanceof GerritError) {
    err(`${colorize('red', 'error')}: ${error.message}`);
    if (error.remedy) {
      err('');
      err(error.remedy);
    }
    if (error instanceof ConfigError) return EXIT.config;
    if (error instanceof AuthError) return EXIT.auth;
    if (error instanceof TransportError) return EXIT.transport;
    return EXIT.error;
  }
  const message = error instanceof Error ? error.message : String(error);
  err(`${colorize('red', 'error')}: ${message}`);
  if (error instanceof Error && error.stack && process.env.GERRIT_DEBUG) {
    err(error.stack);
  }
  return EXIT.error;
}

/**
 * @returns {Promise<string>}
 */
async function packageVersion() {
  const url = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(await readFile(url, 'utf8'));
  return `${pkg.name} ${pkg.version}`;
}
