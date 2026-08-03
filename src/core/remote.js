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
 */

import { ConfigError } from './errors.js';
import { runCommand } from './exec.js';

/** Gerrit's well-known SSH port. A protocol default, not a site default. */
export const DEFAULT_SSH_PORT = 29418;

/**
 * @typedef {Object} ParsedRemote
 * @property {string} host
 * @property {number} port      SSH port; only an ssh:// URL can tell us this
 * @property {string|null} user     username embedded in the URL, if any
 * @property {string|null} project  Gerrit project path, if any
 * @property {'ssh'|'http'|'https'} scheme
 * @property {string|null} restBase  origin for REST calls, when the remote is an
 *   HTTP(S) clone URL that names one; null means "derive https://<host>"
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
