// SPDX-License-Identifier: Apache-2.0

/**
 * The agent tier's entry point: dispatch, and the one place a failure becomes an
 * error record.
 *
 * This tier is a sibling of src/cli/, not a wrapper around it. It imports
 * src/core/ and nothing else, so there is no table to re-parse and no column to
 * shift: the human CLI's layout can change freely without changing a byte of
 * what a consumer here reads. That is why the human `gerrit` has no `--json`.
 */

import { readFile } from 'node:fs/promises';

import { AuthError, ConfigError, GerritError, TransportError } from '../core/errors.js';
import { createSession } from '../core/session.js';
import { parseArgs } from './args.js';
import { opAuth, opComments, opShow, opStatus } from './commands.js';
import { UsageError, errorRecord, serialize } from './output.js';

/** Same codes the human CLI uses, so a caller can drive either interchangeably. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  config: 3,
  auth: 4,
  transport: 5,
};

const USAGE = `gerrit-axi - Gerrit review state as records, for agents

usage: gerrit-axi <command> [options]

Records go to stdout: TOON by default, strict JSON with --json. A failure writes
a typed error record to stderr, leaves stdout empty, and exits non-zero, so a
caller never has to tell data from prose.

commands, and the options each one takes:
  status                      changes awaiting your attention ("your turn")
  status mine                 your open changes
  status <change>...          specific change numbers
  status --query '<query>'    an arbitrary Gerrit query
      --limit <n>             maximum changes to fetch (default 100)
  show <change>...            full review state, one record per change
      --messages <n|all>      also emit that many cover messages (default 0)
      --comments              also emit the inline comments
      --bots | --humans       with --comments: only / never machine-generated
  comments <change>...        inline review comments on every change named
      --bots | --humans       only / never machine-generated
  auth status                 whether the stored credential still works

global options:
  --json          strict JSON instead of TOON
  --host <h>      override the resolved Gerrit host
  --user <u>      override the resolved Gerrit username
  --port <p>      override the Gerrit SSH port
  --project <p>   override the resolved project
  --rest-base <u> override the REST base URL (e.g. https://gerrit.example.com)
  -h, --help      show this help
  -V, --version   print the version

Every command answers about a whole list of changes in one invocation. Per-change
scalars arrive in the 'changes' table; anything per-label arrives in 'labels' and
'votes', keyed by change number and label name, so a label the server gains adds
a row and moves no column.

Host, port, user and project are resolved from the 'origin' git remote of the
current directory first, then from GERRIT_HOST / GERRIT_USER / GERRIT_PORT, then
from the config file. There is no built-in default host.

Exit codes: 0 success, 1 other error, 2 usage, 3 configuration, 4 authentication,
5 transport.

Read-only, like the rest of the tool: it never votes, comments, or mutates
anything.`;

/** Command-specific flags. Everything here is also listed in USAGE above. */
const FLAG_SPECS = {
  status: { withValue: new Set(['--query', '--limit']), boolean: new Set() },
  show: {
    withValue: new Set(['--messages']),
    boolean: new Set(['--comments', '--bots', '--humans']),
  },
  comments: { withValue: new Set(), boolean: new Set(['--bots', '--humans']) },
  auth: { withValue: new Set(), boolean: new Set() },
};

const OPS = {
  status: opStatus,
  show: opShow,
  comments: opComments,
  auth: opAuth,
};

/**
 * @param {string[]} argv          argv without node and script
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, stdout?: NodeJS.WriteStream,
 *          stderr?: NodeJS.WriteStream,
 *          runner?: import('../core/exec.js').Runner, fetchImpl?: typeof fetch}} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    runner,
    fetchImpl,
  } = io;

  const [command, ...rest] = argv;
  const out = (/** @type {string} */ text) => { stdout.write(`${text}\n`); };
  const fail = (/** @type {unknown} */ error, /** @type {string|undefined} */ op) => {
    // Records only ever go to stdout. An error record goes to stderr, always.
    const json = argv.includes('--json');
    stderr.write(`${serialize(errorRecord(error, { op }), { json })}\n`);
    return exitFor(error);
  };

  // Help and version must work with no config, no credential and no network.
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    out(USAGE);
    return command ? EXIT.ok : EXIT.usage;
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    out(await packageVersion());
    return EXIT.ok;
  }

  const op = /** @type {keyof typeof OPS|undefined} */ (
    Object.hasOwn(OPS, command) ? command : undefined
  );
  if (!op) return fail(new UsageError(`unknown command: ${command}`), undefined);

  try {
    const args = parseArgs(rest, FLAG_SPECS[op]);
    if (args.help) {
      out(USAGE);
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
    out(serialize(await OPS[op]({ session, args }), { json: args.json }));
    return EXIT.ok;
  } catch (error) {
    return fail(error, op);
  }
}

/**
 * @param {unknown} error
 * @returns {number}
 */
function exitFor(error) {
  if (error instanceof UsageError) return EXIT.usage;
  if (error instanceof ConfigError) return EXIT.config;
  if (error instanceof AuthError) return EXIT.auth;
  if (error instanceof TransportError) return EXIT.transport;
  if (error instanceof GerritError) return EXIT.error;
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
