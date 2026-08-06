/**
 * Git remote URL parsing.
 *
 * The repo you are standing in is the primary source of connection details --
 * the same thing `gh` and `glab` do. A Gerrit SSH remote looks like
 *
 *     ssh://<user>@<host>:29418/<project/path>
 *
 * so host, user, port, and project all fall out of it. There is deliberately no
 * fallback hostname anywhere in this codebase: outside a Gerrit repo with no
 * config, we report that we cannot determine the host.
 *
 * Parsing a URL is not the same as believing it names a Gerrit server, though.
 * Every addressable remote parses, including a forge that does not speak Gerrit
 * at all, and acting on one means an SSH connection to a port nobody serves --
 * ten seconds of silence, then a confusing failure. `parseRemoteUrl` therefore
 * also classifies the URL's *shape*, and `acceptGerritRemote` decides whether the
 * git-remote tier is allowed to answer with it. Shape, never a host deny-list: a
 * list of known forges fails open for every forge not on it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { ConfigError } from './errors.js';
import { runCommand } from './exec.js';

/** Gerrit's well-known SSH port. A protocol default, not a site default. */
export const DEFAULT_SSH_PORT = 29418;

/**
 * How closely a remote URL matches a shape Gerrit itself publishes.
 *
 * `gerrit`     only Gerrit hands out this form.
 * `ambiguous`  Gerrit hands it out, but so do other forges; needs corroboration
 *              from the repo before we act on it.
 * `foreign`    Gerrit never hands it out.
 *
 * @typedef {'gerrit'|'ambiguous'|'foreign'} RemoteShape
 */

/**
 * @typedef {Object} ParsedRemote
 * @property {string} host
 * @property {number} port      SSH port; only an ssh:// URL can tell us this
 * @property {string|null} user     username embedded in the URL, if any
 * @property {string|null} project  Gerrit project path, if any
 * @property {'ssh'|'http'|'https'} scheme
 * @property {string|null} restBase  origin for REST calls, when the remote is an
 *   HTTP(S) clone URL that names one; null means "derive https://<host>"
 * @property {RemoteShape} shape  how Gerrit-shaped the URL is
 */

/**
 * Parse a git remote URL into Gerrit connection details.
 *
 * Handles `ssh://`, `http://`, `https://` and the scp-style `user@host:path`
 * form. Returns null for anything we do not recognise as addressable (e.g. a
 * local path remote) rather than guessing.
 *
 * @param {string|null|undefined} url
 * @returns {ParsedRemote|null}
 */
export function parseRemoteUrl(url) {
  const raw = (url ?? '').trim();
  if (!raw) return null;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'ssh' && scheme !== 'http' && scheme !== 'https') return null;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      throw new ConfigError(`could not parse remote URL: ${raw}`, {
        code: 'BAD_REMOTE_URL',
        cause: err,
      });
    }
    if (!parsed.hostname) {
      throw new ConfigError(`remote URL has no host: ${raw}`, { code: 'BAD_REMOTE_URL' });
    }
    // A port in an https:// clone URL is the *web* port; it says nothing about
    // where sshd listens, so it must not become the SSH port.
    const isSsh = scheme === 'ssh';
    return {
      host: parsed.hostname,
      port: isSsh && parsed.port ? Number(parsed.port) : DEFAULT_SSH_PORT,
      user: decodeURIComponent(parsed.username) || null,
      project: normalizeProject(parsed.pathname),
      scheme: /** @type {'ssh'|'http'|'https'} */ (scheme),
      restBase: isSsh ? null : `${scheme}://${parsed.host}`,
      // Gerrit advertises its sshd port in the clone URL it hands out, and its
      // authenticated HTTP clone URL carries the `/a/` prefix. Either is a form
      // no ordinary forge publishes. Without one of them the URL is a shape both
      // Gerrit and everyone else uses, so it is only ambiguous.
      shape: (isSsh ? Boolean(parsed.port) : /^\/+a\/.+/.test(parsed.pathname))
        ? 'gerrit'
        : 'ambiguous',
    };
  }

  // scp-style: [user@]host:path -- no port is expressible in this form.
  const scp = /^(?:([^@/]+)@)?([^@:/]+):(.+)$/.exec(raw);
  if (scp) {
    return {
      host: scp[2],
      port: DEFAULT_SSH_PORT,
      user: scp[1] ?? null,
      project: normalizeProject(scp[3]),
      scheme: 'ssh',
      restBase: null,
      // Gerrit does not publish this form at all, and it cannot express a port,
      // so acting on it means guessing the one thing that has to be right.
      shape: 'foreign',
    };
  }

  return null;
}

/**
 * Gerrit project paths carry neither a leading slash nor a `.git` suffix, and
 * HTTP clone URLs additionally carry Gerrit's `/a/` authenticated prefix.
 *
 * @param {string} pathname
 * @returns {string|null}
 */
function normalizeProject(pathname) {
  let p = decodeURIComponent(pathname ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.startsWith('a/')) p = p.slice(2);
  if (p.endsWith('.git')) p = p.slice(0, -4);
  return p || null;
}

/**
 * Look for evidence *in the repository* that it is worked on through Gerrit.
 *
 * Used only to settle an ambiguous URL shape. Two signals, both of which a repo
 * acquires by being used with Gerrit and by nothing else:
 *
 *   - a configured refspec aiming at `refs/for/`, Gerrit's magic namespace;
 *   - the `commit-msg` hook Gerrit tells you to install, recognisable because
 *     stamping `Change-Id` is the whole reason it exists.
 *
 * Absence of evidence is not an error -- no git, no hook, a bare `git config`
 * miss -- so every failure here reads as "no evidence".
 *
 * @param {{cwd?: string, remote?: string, runner?: import('./exec.js').Runner,
 *          readFile?: (p: string) => Promise<string>}} [opts]
 * @returns {Promise<'refspec'|'commit-msg-hook'|null>} which signal was found
 */
export async function gerritRepoEvidence({
  cwd = process.cwd(),
  remote = 'origin',
  runner = runCommand,
  readFile,
} = {}) {
  const read = readFile ?? ((p) => fs.readFile(p, 'utf8'));

  try {
    const result = await runner(
      'git', ['-C', cwd, 'config', '--get-all', `remote.${remote}.push`], { timeoutMs: 5_000 },
    );
    if (result.code === 0 && /(?:^|[\s:+])refs\/for\//m.test(result.stdout)) return 'refspec';
  } catch {
    // git unavailable; the hook probe below needs it too, so we are done.
    return null;
  }

  try {
    // --git-path resolves core.hooksPath and the linked-worktree layout for us.
    const located = await runner(
      'git', ['-C', cwd, 'rev-parse', '--git-path', 'hooks/commit-msg'], { timeoutMs: 5_000 },
    );
    if (located.code !== 0 || !located.stdout.trim()) return null;
    const hook = await read(path.resolve(cwd, located.stdout.trim()));
    if (/Change-Id/.test(hook)) return 'commit-msg-hook';
  } catch {
    // No hook, or it is unreadable. Either way: no evidence.
  }
  return null;
}

/**
 * Decide whether the git-remote tier may answer with this remote.
 *
 * A remote we do not recognise as Gerrit's contributes *nothing*: the caller gets
 * `remote: null` and resolution falls through to the environment and then the
 * config file, exactly as if the repo had no remote. Host, port, user and project
 * all come from this one URL, so they fall away together -- a project path or
 * username from some other forge quietly mixed into an environment-supplied
 * Gerrit host would look like it had worked.
 *
 * @param {ParsedRemote|null} parsed
 * @param {{cwd?: string, remote?: string, runner?: import('./exec.js').Runner,
 *          readFile?: (p: string) => Promise<string>}} [opts]
 * @returns {Promise<{remote: ParsedRemote|null, shape: RemoteShape|'absent',
 *                    evidence: 'refspec'|'commit-msg-hook'|null}>}
 */
export async function acceptGerritRemote(parsed, opts = {}) {
  if (!parsed) return { remote: null, shape: 'absent', evidence: null };
  if (parsed.shape === 'gerrit') return { remote: parsed, shape: 'gerrit', evidence: null };
  if (parsed.shape === 'foreign') return { remote: null, shape: 'foreign', evidence: null };
  const evidence = await gerritRepoEvidence(opts);
  return { remote: evidence ? parsed : null, shape: 'ambiguous', evidence };
}

/**
 * Read a remote URL from the git repository containing `cwd`.
 *
 * Returns null when there is no repo, no such remote, or git is unavailable --
 * all of which are ordinary situations, not errors.
 *
 * @param {{cwd?: string, remote?: string, runner?: import('./exec.js').Runner}} [opts]
 * @returns {Promise<string|null>}
 */
export async function readGitRemoteUrl({
  cwd = process.cwd(),
  remote = 'origin',
  runner = runCommand,
} = {}) {
  let result;
  try {
    result = await runner('git', ['-C', cwd, 'remote', 'get-url', remote], { timeoutMs: 5_000 });
  } catch {
    return null; // git not installed
  }
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}
