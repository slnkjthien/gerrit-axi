// SPDX-License-Identifier: Apache-2.0

/**
 * `gerrit-axi setup`: the opt-in session integration, and the only code that
 * writes into an agent's own configuration.
 *
 * `setup hooks` registers `gerrit-axi dashboard --ambient` to run at session
 * start in Claude Code, Codex and OpenCode, so a session opens already knowing
 * the tool exists and what awaits the user. Nothing else registers it: no
 * ordinary command touches these files. `setup hooks --remove` takes out only
 * what `setup hooks` put in, recognised by its command line, and leaves every
 * other hook, and the Codex hooks feature flag other tools rely on, alone.
 * `setup config` writes the connection this checkout resolves to into the
 * config file, and only when there is none.
 *
 * None of it reads, prompts for, stores or passes a credential. The sign-in
 * check is core's `authStatus`, the same one `gerrit-axi auth status` runs, and
 * a missing credential is reported with the human command that stores one.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { authStatus } from '../core/auth.js';
import { saveConnection } from '../core/config.js';
import { ConfigError } from '../core/errors.js';
import { command, shellWord } from './hints.js';
import { UsageError } from './output.js';

/** What a session-start hook runs after the binary. */
export const AMBIENT_ARGS = /** @type {const} */ (['dashboard', '--ambient']);

/** Seconds an agent waits for the hook: the house default across the -axi tools. */
const HOOK_TIMEOUT_SECONDS = 10;

/** The first line of the OpenCode plugin file, which is how removal knows it is ours. */
const OPENCODE_MARKER = '// gerrit-axi managed opencode plugin';

/**
 * A hook entry is ours when its command runs a gerrit-axi binary with exactly
 * the ambient arguments. Matching on both, rather than on the name alone, keeps
 * a hook someone wrote by hand that happens to mention gerrit-axi out of reach.
 *
 * @param {unknown} hook
 * @returns {boolean}
 */
function isManagedHook(hook) {
  const cmd = /** @type {any} */ (hook)?.command;
  return typeof cmd === 'string' && cmd.includes('gerrit-axi')
    && cmd.trim().endsWith(` ${AMBIENT_ARGS.join(' ')}`);
}

/**
 * The home directory, from the environment this call was given and never from
 * the process's, so a caller that supplies an environment decides where writes
 * land.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function homeOf(env) {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) {
    throw new ConfigError('cannot find the home directory: HOME is not set', { code: 'NO_HOME' });
  }
  return home;
}

/**
 * Where each agent keeps what `setup hooks` writes. Each honours the variable
 * its agent does for relocating its configuration.
 *
 * @param {NodeJS.ProcessEnv} env
 */
export function hookPaths(env) {
  const home = homeOf(env);
  const claude = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  const codex = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return {
    home,
    claude: path.join(claude, 'settings.json'),
    codexHooks: path.join(codex, 'hooks.json'),
    codexConfig: path.join(codex, 'config.toml'),
    opencode: path.join(xdg, 'opencode', 'plugins', 'axi-gerrit-axi.js'),
  };
}

/**
 * The binary a hook should run: the bare name when `gerrit-axi` on PATH is this
 * very executable, so the hook survives an upgrade in place, and the absolute
 * path otherwise, so it never runs some other gerrit-axi. `bin` is where that
 * binary lives, as the ambient view names it.
 *
 * @param {{execPath: string, env: NodeJS.ProcessEnv}} ctx
 * @returns {{argv: string[], bin: string}}
 */
export function hookCommand({ execPath, env }) {
  const self = realpath(execPath) ?? path.resolve(execPath);
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'gerrit-axi');
    if (realpath(candidate) === self) return { argv: ['gerrit-axi', ...AMBIENT_ARGS], bin: candidate };
  }
  return { argv: [self, ...AMBIENT_ARGS], bin: self };
}

/**
 * @param {string} file
 * @returns {string|undefined}
 */
function realpath(file) {
  try {
    return statSync(file).isFile() ? realpathSync(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `path` for display: under the home directory it starts `~`.
 *
 * @param {string} file
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function tildify(file, env) {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) return file;
  const rel = path.relative(home, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel}` : file;
}

/**
 * The settings with our SessionStart hook present and current, and what that
 * took. Claude Code's settings.json and Codex's hooks.json share this shape.
 *
 * @param {any} settings
 * @param {string} cmd
 * @returns {[any, 'installed'|'updated'|'unchanged']}
 */
export function withHook(settings, cmd) {
  const next = structuredClone(settings);
  next.hooks ??= {};
  next.hooks.SessionStart = Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [];
  const managed = next.hooks.SessionStart.flatMap(
    (/** @type {any} */ group) => (Array.isArray(group?.hooks) ? group.hooks : []).filter(isManagedHook),
  );
  if (managed.length > 0) {
    const [first] = managed;
    if (managed.length === 1 && first.command === cmd && first.type === 'command'
      && first.timeout === HOOK_TIMEOUT_SECONDS) {
      return [settings, 'unchanged'];
    }
    Object.assign(first, { type: 'command', command: cmd, timeout: HOOK_TIMEOUT_SECONDS });
    next.hooks.SessionStart = next.hooks.SessionStart.flatMap((/** @type {any} */ group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const hooks = group.hooks.filter((/** @type {any} */ hook) => hook === first || !isManagedHook(hook));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length > 0 ? [{ ...group, hooks }] : [];
    });
    return [next, 'updated'];
  }
  next.hooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command: cmd, timeout: HOOK_TIMEOUT_SECONDS }],
  });
  return [next, 'installed'];
}

/**
 * The settings with our hook taken out, and whether there was one. A group left
 * empty goes, and so do `SessionStart` and `hooks` when nothing else is in them;
 * everything else is kept as it was.
 *
 * @param {any} settings
 * @returns {[any, boolean]}
 */
export function withoutHook(settings) {
  const groups = settings?.hooks?.SessionStart;
  if (!Array.isArray(groups)) return [settings, false];
  const next = structuredClone(settings);
  let removed = false;
  const kept = [];
  for (const group of next.hooks.SessionStart) {
    if (!Array.isArray(group?.hooks)) {
      kept.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => !isManagedHook(hook));
    if (hooks.length === group.hooks.length) {
      kept.push(group);
      continue;
    }
    removed = true;
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  if (!removed) return [settings, false];
  if (kept.length > 0) next.hooks.SessionStart = kept;
  else delete next.hooks.SessionStart;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return [next, true];
}

/**
 * Codex runs hooks only with `hooks = true` under `[features]` in its user
 * config. Returns the text with that set, and whether it had to change. Every
 * other line is left byte for byte.
 *
 * @param {string} text
 * @returns {[string, boolean]}
 */
export function withCodexHooksFeature(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (text.trim() === '') return [`[features]${nl}hooks = true${nl}`, true];
  const lines = text.split(/\r?\n/);
  let inFeatures = false;
  let sawFeatures = false;
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^\s*\[{1,2}([^\]]+)\]{1,2}\s*(?:#.*)?$/);
    if (header) {
      if (inFeatures) {
        lines.splice(i, 0, 'hooks = true');
        return [lines.join(nl), true];
      }
      inFeatures = header[1].trim() === 'features';
      sawFeatures ||= inFeatures;
      continue;
    }
    if (!inFeatures) continue;
    const flag = lines[i].match(/^\s*hooks\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!flag) continue;
    if (flag[1] === 'true') return [text, false];
    lines[i] = lines[i].replace('false', 'true');
    return [lines.join(nl), true];
  }
  const end = text.endsWith(nl) ? '' : nl;
  return sawFeatures
    ? [`${text}${end}hooks = true${nl}`, true]
    : [`${text}${end}${nl}[features]${nl}hooks = true${nl}`, true];
}

/**
 * The OpenCode plugin: OpenCode has no session-start hook, so the plugin runs
 * the ambient view once per session and adds it to the system context. It runs
 * the binary without a shell, and a failure becomes one line of context rather
 * than a broken session.
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function openCodePlugin(argv) {
  const [file, ...args] = argv;
  return `${OPENCODE_MARKER} -- written by \`gerrit-axi setup hooks\`, removed by \`gerrit-axi setup hooks --remove\`.
import { execFile } from 'node:child_process';

const file = ${JSON.stringify(file)};
const args = ${JSON.stringify(args)};

function ambient(cwd) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: ${HOOK_TIMEOUT_SECONDS * 1000} }, (error, stdout) => {
      resolve(error && !stdout ? 'gerrit-axi ambient context failed: ' + error.message : String(stdout).trim());
    });
  });
}

export const GerritAxiAmbientContextPlugin = async ({ directory }) => {
  const seen = new Map();
  return {
    'experimental.chat.system.transform': async (input, output) => {
      const key = input.sessionID ?? '';
      if (!seen.has(key)) seen.set(key, await ambient(directory || process.cwd()));
      const text = seen.get(key);
      if (text) output.system.push('## gerrit-axi ambient context\\n' + text);
    },
  };
};
`;
}

/**
 * @typedef {{agent: string, path: string, action: string}} TargetRow
 * @typedef {{path: string, error: string}} FailureRow
 */

/**
 * The per-file outcome rows, and `attempt`, which runs one file's change and
 * records either its action or, if it threw, a failure -- so one bad file never
 * stops the others.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function tally(env) {
  /** @type {TargetRow[]} */
  const targets = [];
  /** @type {FailureRow[]} */
  const failures = [];
  const attempt = (/** @type {string} */ agent, /** @type {string} */ file, /** @type {() => string} */ fn) => {
    try {
      targets.push({ agent, path: tildify(file, env), action: fn() });
    } catch (err) {
      targets.push({ agent, path: tildify(file, env), action: 'failed' });
      failures.push({ path: tildify(file, env), error: /** @type {Error} */ (err).message });
    }
  };
  return { targets, failures, attempt };
}

/**
 * Install or repair the hook for every agent. A file that cannot be parsed, or a
 * plugin file someone else wrote, is reported and left exactly as it was.
 *
 * @param {{argv: string[], env: NodeJS.ProcessEnv}} ctx
 * @returns {{targets: TargetRow[], failures: FailureRow[]}}
 */
export function installHooks({ argv, env }) {
  const paths = hookPaths(env);
  const cmd = argv.map(shellWord).join(' ');
  const { targets, failures, attempt } = tally(env);

  for (const [agent, file] of [['claude', paths.claude], ['codex', paths.codexHooks]]) {
    attempt(agent, file, () => {
      const [next, action] = withHook(readJson(file) ?? {}, cmd);
      if (action !== 'unchanged') writeText(file, `${JSON.stringify(next, null, 2)}\n`);
      return action;
    });
  }
  attempt('codex-feature', paths.codexConfig, () => {
    const current = readText(paths.codexConfig) ?? '';
    const [next, changed] = withCodexHooksFeature(current);
    if (!changed) return 'unchanged';
    writeText(paths.codexConfig, next);
    return current === '' ? 'installed' : 'updated';
  });
  attempt('opencode', paths.opencode, () => {
    const current = readText(paths.opencode);
    const next = openCodePlugin(argv);
    if (current === next) return 'unchanged';
    if (current !== undefined && !current.startsWith(OPENCODE_MARKER)) {
      throw new Error('a plugin gerrit-axi did not write is already there; left as is');
    }
    writeText(paths.opencode, next);
    return current === undefined ? 'installed' : 'updated';
  });
  return { targets, failures };
}

/**
 * Take out what `installHooks` put in, and nothing else. The Codex feature flag
 * stays: other tools' hooks need it too, and it does nothing without a hook.
 *
 * @param {{env: NodeJS.ProcessEnv}} ctx
 * @returns {{targets: TargetRow[], failures: FailureRow[]}}
 */
export function removeHooks({ env }) {
  const paths = hookPaths(env);
  const { targets, failures, attempt } = tally(env);

  for (const [agent, file] of [['claude', paths.claude], ['codex', paths.codexHooks]]) {
    attempt(agent, file, () => {
      const current = readJson(file);
      if (current === undefined) return 'absent';
      const [next, removed] = withoutHook(current);
      if (!removed) return 'absent';
      writeText(file, `${JSON.stringify(next, null, 2)}\n`);
      return 'removed';
    });
  }
  targets.push({ agent: 'codex-feature', path: tildify(paths.codexConfig, env), action: 'kept' });
  attempt('opencode', paths.opencode, () => {
    const current = readText(paths.opencode);
    if (current === undefined) return 'absent';
    if (!current.startsWith(OPENCODE_MARKER)) {
      throw new Error('a plugin gerrit-axi did not write is there; left as is');
    }
    rmSync(paths.opencode, { force: true });
    return 'removed';
  });
  return { targets, failures };
}

/**
 * @param {string} file
 * @returns {string|undefined} undefined when there is no such file
 */
function readText(file) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8');
}

/**
 * @param {string} file
 * @returns {any} undefined when there is no such file
 */
function readJson(file) {
  const text = readText(file);
  if (text === undefined) return undefined;
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON, so left as is: ${/** @type {Error} */ (err).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not a JSON object, so left as is');
  }
  return parsed;
}

/**
 * @param {string} file
 * @param {string} text
 */
function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/**
 * What stands between this checkout and a working gerrit-axi, as at most one
 * line, with the human command that fixes it; and whether to offer
 * `setup config`. It asks core and never touches a credential itself.
 *
 * @param {() => Promise<import('../core/session.js').Session>} connect
 * @param {import('./args.js').ParsedArgs['overrides']} overrides
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{fields: Record<string, unknown>, help: string[]}>}
 */
async function readiness(connect, overrides, env) {
  /** @type {import('../core/session.js').Session} */
  let session;
  try {
    session = await connect();
  } catch (err) {
    const e = /** @type {any} */ (err);
    const line = e?.code === 'HOST_UNRESOLVED' && /username/.test(String(e.message))
      ? 'No Gerrit user resolves here: run `export GERRIT_USER=<name>`'
      : e?.code === 'HOST_UNRESOLVED'
        ? 'No Gerrit host resolves here: run setup in a checkout whose origin is a Gerrit remote,'
          + ' or `export GERRIT_HOST=<host>`'
        : `The connection does not resolve: ${String(e?.message ?? err)}`;
    return { fields: { host: null, port: null, user: null, signed_in: null }, help: [line] };
  }

  const { host, port, user, sources, configPath } = session.config;
  const fields = { host, port, user, signed_in: /** @type {boolean|null} */ (null) };
  /** @type {string[]} */
  const help = [];
  try {
    const status = await authStatus(session);
    fields.signed_in = status.stored && status.verified;
    if (!status.stored) help.push('Not signed in: run `gerrit auth login`');
    else if (!status.verified) help.push(`${host} rejected the stored credential: run \`gerrit auth login\``);
  } catch (err) {
    help.push(`Could not check the credential with ${host} (${/** @type {Error} */ (err).message}):`
      + ` run \`${command(['auth', 'status'], overrides)}\` once it is reachable`);
  }
  if (sources.host === 'git-remote' && !existsSync(configPath)) {
    help.push(`Run \`${command(['setup', 'config'], overrides)}\` to save this checkout's host, port`
      + ` and user to ${tildify(configPath, env)}, so gerrit-axi resolves outside it too`);
  }
  return { fields, help };
}

/**
 * `setup hooks`, `setup hooks --remove`, and `setup config`.
 *
 * @param {{args: import('./args.js').ParsedArgs, connect: () => Promise<import('../core/session.js').Session>,
 *          env: NodeJS.ProcessEnv, execPath: string}} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opSetup({ args, connect, env, execPath }) {
  const { positional, flags, overrides } = args;
  const [what, ...extra] = positional;
  const choices = [`\`${command(['setup', 'hooks'], overrides)}\``,
    `\`${command(['setup', 'hooks', '--remove'], overrides)}\``,
    `\`${command(['setup', 'config'], overrides)}\``];
  if ((what !== 'hooks' && what !== 'config') || extra.length > 0) {
    throw new UsageError(`unknown setup action: ${positional.join(' ') || '(none)'}`, undefined,
      [`Run one of: ${choices.join(', ')}`]);
  }

  if (what === 'config') {
    if (flags['--remove']) throw new UsageError('--remove applies to setup hooks only');
    return setupConfig(connect, env);
  }

  if (flags['--remove']) {
    const { targets, failures } = removeHooks({ env });
    const removed = targets.some((t) => t.action === 'removed');
    return {
      ok: true,
      op: 'setup hooks --remove',
      status: failures.length > 0 ? 'partial' : removed ? 'removed' : 'absent',
      targets,
      ...(failures.length > 0 ? { failures } : {}),
      ...(failures.length > 0
        ? { help: [`Fix the files under failures, then run \`${command(['setup', 'hooks', '--remove'], overrides)}\` again`] }
        : removed ? { help: ['Restart your agent session to stop receiving gerrit-axi ambient context'] } : {}),
    };
  }

  const check = await readiness(connect, overrides, env);
  const { argv } = hookCommand({ execPath, env });
  const { targets, failures } = installHooks({ argv, env });
  const changed = targets.some((t) => t.action === 'installed' || t.action === 'updated');
  /** @type {string[]} */
  const help = [];
  if (failures.length > 0) {
    help.push(`Fix the files under failures, then run \`${command(['setup', 'hooks'], overrides)}\` again`);
  } else if (changed) {
    help.push('Restart your agent session to receive gerrit-axi ambient context');
  }
  help.push(...check.help);
  help.push(`Run \`${command(['setup', 'hooks', '--remove'], overrides)}\` to take the hooks out again`);
  return {
    ok: true,
    op: 'setup hooks',
    status: failures.length > 0 ? 'partial' : changed ? 'installed' : 'unchanged',
    hook: argv.map(shellWord).join(' '),
    targets,
    ...(failures.length > 0 ? { failures } : {}),
    ...check.fields,
    help,
  };
}

/**
 * @param {() => Promise<import('../core/session.js').Session>} connect
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Record<string, unknown>>}
 */
async function setupConfig(connect, env) {
  const notACheckout = () => new ConfigError(
    "this directory's origin is not a Gerrit remote, so there is nothing to save", {
      code: 'NOT_A_GERRIT_CHECKOUT',
      remedy: 'Run it in a checkout whose origin remote points at Gerrit.',
    });
  /** @type {import('../core/session.js').Session} */
  let session;
  try {
    session = await connect();
  } catch (err) {
    // No host at all means no Gerrit origin either; the generic remedy's
    // --host and GERRIT_HOST would only lead to this same refusal.
    const e = /** @type {any} */ (err);
    if (e?.code === 'HOST_UNRESOLVED' && !/username/.test(String(e.message))) throw notACheckout();
    throw err;
  }
  const { host, port, user, sources } = session.config;
  if (sources.host !== 'git-remote') throw notACheckout();
  const saved = await saveConnection({ host, port, user }, { env });
  return {
    ok: true,
    op: 'setup config',
    status: saved.written ? 'written' : 'exists',
    path: tildify(saved.path, env),
    host,
    port,
    user,
  };
}
