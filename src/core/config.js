// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration resolution.
 *
 * Guiding principle: derive from the server, then from the repo, and configure
 * only what genuinely cannot be derived.
 *
 *   tier 1  label names, readiness, bot detection  -- asked of the server
 *   tier 2  host / port / user / project           -- read off the git remote
 *   tier 3  severity patterns                      -- local convention, opt-in
 *
 * Precedence for tier 2, highest first:
 *
 *   0. explicit overrides (CLI flags)
 *   1. the `origin` git remote of the current directory   <- primary source
 *   2. environment variables
 *   3. the config file
 *
 * The git remote outranks the environment on purpose: the repo you are standing
 * in identifies the server you mean, and a stale exported GERRIT_HOST should not
 * silently redirect queries about it. `--host` remains the escape hatch.
 *
 * The git-remote step answers only for a remote we recognise as Gerrit's -- see
 * `acceptGerritRemote` in remote.js. Any other remote contributes nothing at all,
 * so standing in a repo hosted somewhere else is indistinguishable from standing
 * in a repo with no remote, and never means an SSH attempt at a forge that does
 * not speak Gerrit.
 *
 * There is no built-in hostname. If none of the sources yields one we say so and
 * say how to fix it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ConfigError } from './errors.js';
import { runCommand } from './exec.js';
import {
  DEFAULT_SSH_PORT,
  acceptGerritRemote,
  parseRemoteUrl,
  readGitRemoteUrl,
} from './remote.js';
import { assertSafeConnection } from './ssh.js';

/** @typedef {'override'|'git-remote'|'env'|'config-file'|'derived'} SourceName */

/**
 * @typedef {Object} SeverityPattern
 * @property {string} name      label to attach, e.g. "issue"
 * @property {string} pattern   JS regular expression source
 * @property {string} [flags]   regexp flags; defaults to "i"
 */

/**
 * @typedef {Object} ResolvedConfig
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {string|null} project
 * @property {string} restBase          origin used for REST calls
 * @property {SeverityPattern[]} severityPatterns
 * @property {Record<string, SourceName>} sources  where each field came from
 * @property {string} configPath        where the config file is looked for
 */

/**
 * Directory holding config and (in the worst case) the credential file.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function configDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
  return path.join(base, 'gerrit-axi');
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function configPath(env = process.env) {
  return path.join(configDir(env), 'config.json');
}

/**
 * Read and validate the config file. A missing file is not an error.
 *
 * @param {{env?: NodeJS.ProcessEnv, readFile?: (p: string) => Promise<string>}} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function readConfigFile({ env = process.env, readFile } = {}) {
  const file = configPath(env);
  const read = readFile ?? ((p) => fs.readFile(p, 'utf8'));
  let text;
  try {
    text = await read(file);
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return {};
    throw new ConfigError(`could not read ${file}: ${/** @type {Error} */ (err).message}`, {
      code: 'BAD_CONFIG_FILE',
      cause: err,
    });
  }
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top level value must be a JSON object');
    }
    return parsed;
  } catch (err) {
    throw new ConfigError(`invalid JSON in ${file}: ${/** @type {Error} */ (err).message}`, {
      code: 'BAD_CONFIG_FILE',
      cause: err,
    });
  }
}

/**
 * Validate the tier-3 severity block. Absent or empty means "no severity" --
 * the out-of-the-box behaviour is to print comments raw with no severity column.
 *
 * @param {any} raw   the `severity` value from the config file
 * @returns {SeverityPattern[]}
 */
export function normalizeSeverityPatterns(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : raw.patterns;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new ConfigError('severity.patterns must be an array', {
      code: 'BAD_SEVERITY_PATTERN',
    });
  }
  return list.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') {
      throw new ConfigError(`severity.patterns[${i}] must be an object`, {
        code: 'BAD_SEVERITY_PATTERN',
      });
    }
    const { name, pattern, flags = 'i' } = entry;
    if (typeof name !== 'string' || !name) {
      throw new ConfigError(`severity.patterns[${i}].name must be a non-empty string`, {
        code: 'BAD_SEVERITY_PATTERN',
      });
    }
    if (typeof pattern !== 'string' || !pattern) {
      throw new ConfigError(`severity.patterns[${i}].pattern must be a non-empty string`, {
        code: 'BAD_SEVERITY_PATTERN',
      });
    }
    if (typeof flags !== 'string') {
      throw new ConfigError(`severity.patterns[${i}].flags must be a string`, {
        code: 'BAD_SEVERITY_PATTERN',
      });
    }
    try {
      new RegExp(pattern, flags);
    } catch (err) {
      throw new ConfigError(
        `severity.patterns[${i}] is not a valid regular expression: ${/** @type {Error} */ (err).message}`,
        { code: 'BAD_SEVERITY_PATTERN', cause: err },
      );
    }
    return { name, pattern, flags };
  });
}

/**
 * @param {{host?: string, port?: number|string, user?: string, project?: string,
 *          restBase?: string}} overrides
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, runner?: import('./exec.js').Runner,
 *          readFile?: (p: string) => Promise<string>,
 *          readRepoFile?: (p: string) => Promise<string>, remoteUrl?: string|null}} [deps]
 * @returns {Promise<ResolvedConfig>}
 */
export async function resolveConfig(overrides = {}, deps = {}) {
  const { cwd = process.cwd(), env = process.env, runner = runCommand, readFile } = deps;

  const fileConfig = await readConfigFile({ env, readFile });

  const remoteUrl = deps.remoteUrl !== undefined
    ? deps.remoteUrl
    : await readGitRemoteUrl({ cwd, runner });
  const parsedRemote = parseRemoteUrl(remoteUrl);
  // A remote that is not recognisably Gerrit's is dropped whole: `remote` is null
  // and every field below falls through to the environment and the config file.
  const { remote } = await acceptGerritRemote(parsedRemote, {
    cwd, runner, readFile: deps.readRepoFile,
  });

  /** @type {Record<string, SourceName>} */
  const sources = {};

  /**
   * Walk the tiers for one field and remember which tier answered.
   * @param {string} field
   * @param {Array<[SourceName, unknown]>} candidates
   * @returns {any}
   */
  const pick = (field, candidates) => {
    for (const [source, value] of candidates) {
      if (value !== undefined && value !== null && value !== '') {
        sources[field] = source;
        return value;
      }
    }
    return undefined;
  };

  const host = pick('host', [
    ['override', overrides.host],
    ['git-remote', remote?.host],
    ['env', env.GERRIT_HOST?.trim()],
    ['config-file', typeof fileConfig.host === 'string' ? fileConfig.host.trim() : undefined],
  ]);

  if (!host) {
    throw new ConfigError('cannot determine the Gerrit host', {
      code: 'HOST_UNRESOLVED',
      remedy: [
        // Say why the repo we are standing in did not answer, when it had a
        // remote and that remote was the thing we declined to trust.
        ...(parsedRemote && !remote
          ? [`This repo's git remote (${String(remoteUrl).trim()}) is not a Gerrit remote, so it was ignored.`, '']
          : []),
        'Do one of the following:',
        "  * run this inside a repo whose 'origin' remote points at Gerrit",
        '        git remote -v   ->   ssh://<user>@<host>:29418/<project/path>',
        '  * export GERRIT_HOST=<host>   (optionally GERRIT_USER, GERRIT_PORT)',
        `  * create ${configPath(env)} containing`,
        '        { "host": "<host>", "user": "<user>" }',
        '  * pass --host <host> on the command line',
      ].join('\n'),
    });
  }

  const rawPort = pick('port', [
    ['override', overrides.port],
    ['git-remote', remote?.port],
    ['env', env.GERRIT_PORT?.trim()],
    ['config-file', fileConfig.port],
  ]);
  const port = rawPort === undefined ? DEFAULT_SSH_PORT : Number(rawPort);
  if (rawPort === undefined) sources.port = 'derived';
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`invalid Gerrit SSH port: ${rawPort}`, { code: 'BAD_CONFIG_FILE' });
  }

  const user = pick('user', [
    ['override', overrides.user],
    ['git-remote', remote?.user],
    ['env', env.GERRIT_USER?.trim()],
    ['config-file', typeof fileConfig.user === 'string' ? fileConfig.user.trim() : undefined],
    ['derived', safeLocalUsername()],
  ]);
  if (!user) {
    throw new ConfigError('cannot determine the Gerrit username', {
      code: 'HOST_UNRESOLVED',
      remedy: 'Set GERRIT_USER, add "user" to the config file, or pass --user <name>.',
    });
  }
  assertSafeConnection({ host, user }, sources);

  const project = pick('project', [
    ['override', overrides.project],
    ['git-remote', remote?.project],
    ['config-file', typeof fileConfig.project === 'string' ? fileConfig.project : undefined],
  ]) ?? null;

  // REST base: an HTTP(S) remote names one; otherwise Gerrit's web endpoint is
  // https on the same host. `restBase` in the config file covers deployments
  // behind a path prefix or a non-standard port.
  const restBase = pick('restBase', [
    ['override', overrides.restBase],
    ['git-remote', remote?.restBase],
    ['env', env.GERRIT_REST_BASE?.trim()],
    ['config-file', typeof fileConfig.restBase === 'string' ? fileConfig.restBase.trim() : undefined],
    ['derived', `https://${host}`],
  ]).replace(/\/+$/, '');

  return {
    host,
    port,
    user,
    project,
    restBase,
    severityPatterns: normalizeSeverityPatterns(fileConfig.severity),
    sources,
    configPath: configPath(env),
  };
}

/**
 * The local login name, when it is knowable. Not a configured default -- it is
 * derived, and it is the last thing consulted.
 *
 * @returns {string|undefined}
 */
function safeLocalUsername() {
  try {
    return os.userInfo().username || undefined;
  } catch {
    return undefined;
  }
}
