/**
 * REST transport.
 *
 * The REST channel exists because SSH cannot reach inline comments. Gerrit
 * answers `WWW-Authenticate: Basic realm="Gerrit Code Review"`: this is HTTP
 * Basic carrying a Gerrit authentication token, *not* an OAuth bearer token.
 *
 * Two things about Gerrit's REST API that bite everyone once:
 *   1. Every JSON body is prefixed with the XSSI guard line `)]}'`, which must be
 *      stripped before parsing.
 *   2. 401, 403 and 404 mean genuinely different things and must not collapse
 *      into one generic failure. 401 is "your credential is bad or expired" and
 *      is the only one that means "re-run auth login".
 *
 * Credentials travel in request headers of an in-process HTTP client. We never
 * shell out to curl, so they never touch a command line.
 */

import { AuthError, TransportError } from './errors.js';

/** Gerrit's cross-site-script-inclusion guard, emitted as the first line. */
export const XSSI_PREFIX = ")]}'";

/**
 * Strip Gerrit's XSSI guard line, if present. A body without the guard is
 * returned untouched, so this is safe to apply unconditionally.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripXssiPrefix(body) {
  const text = String(body ?? '');
  if (!text.startsWith(XSSI_PREFIX)) return text;
  const newline = text.indexOf('\n', XSSI_PREFIX.length);
  return newline === -1 ? '' : text.slice(newline + 1);
}

/**
 * Strip the XSSI guard and parse.
 *
 * @template T
 * @param {string} body
 * @param {string} [what]  path or description, for the error message
 * @returns {T}
 */
export function parseGerritJson(body, what = 'response') {
  const json = stripXssiPrefix(body);
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new TransportError(`could not parse JSON from ${what}`, {
      code: 'BAD_RESPONSE',
      cause: err,
    });
  }
}

/**
 * Build the Basic credential header value.
 *
 * The returned string contains the token, so it must only ever be handed to the
 * HTTP client -- never logged, printed, or attached to an error.
 *
 * @param {string} user
 * @param {string} token
 * @returns {string}
 */
export function basicAuthHeader(user, token) {
  return `Basic ${Buffer.from(`${user}:${token}`, 'utf8').toString('base64')}`;
}

/**
 * @typedef {Object} RestTarget
 * @property {string} restBase   e.g. "https://gerrit.example.com"
 * @property {string} user
 * @property {string} token
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * Authenticated GET returning the raw body plus status. Does not throw on HTTP
 * status; `restGetJson` applies the status policy.
 *
 * @param {RestTarget} target
 * @param {string} apiPath   path beginning with "/a/"
 * @returns {Promise<{status: number, body: string, headers: Headers}>}
 */
export async function restGetRaw(target, apiPath) {
  const doFetch = target.fetchImpl ?? globalThis.fetch;
  const url = `${target.restBase.replace(/\/+$/, '')}${apiPath}`;
  let res;
  try {
    res = await doFetch(url, {
      method: 'GET',
      headers: {
        // The only place the token appears.
        Authorization: basicAuthHeader(target.user, target.token),
        Accept: 'application/json',
      },
      // Never follow a redirect while carrying an Authorization header.
      redirect: 'manual',
    });
  } catch (err) {
    throw new TransportError(`could not reach ${url}`, { code: 'HTTP_ERROR', cause: err });
  }
  return { status: res.status, body: await res.text(), headers: res.headers };
}

/**
 * Authenticated GET returning parsed JSON, with 401/403/404 kept distinct.
 *
 * @template T
 * @param {RestTarget} target
 * @param {string} apiPath
 * @returns {Promise<T>}
 */
export async function restGetJson(target, apiPath) {
  const { status, body } = await restGetRaw(target, apiPath);
  assertRestOk(status, apiPath, target.restBase);
  return parseGerritJson(body, apiPath);
}

/**
 * The status policy, factored out so it is testable on its own.
 *
 * @param {number} status
 * @param {string} apiPath
 * @param {string} restBase
 */
export function assertRestOk(status, apiPath, restBase = '') {
  if (status >= 200 && status < 300) return;
  const host = restBase.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  switch (status) {
    case 401:
      throw new AuthError('Gerrit rejected the stored credential (HTTP 401)', {
        code: 'UNAUTHORIZED',
        remedy: [
          `The token is wrong, expired, or revoked. Generate a new one at`,
          `    https://${host}/settings/#HTTPCredentials`,
          'then run: gerrit auth login',
        ].join('\n'),
      });
    case 403:
      throw new TransportError(`not permitted to read ${apiPath} (HTTP 403)`, {
        code: 'FORBIDDEN',
        remedy: 'The credential authenticated, but this account lacks access to that resource.',
      });
    case 404:
      throw new TransportError(`no such resource: ${apiPath} (HTTP 404)`, {
        code: 'NOT_FOUND',
        remedy: 'Check the change number; a change you cannot see also reads as 404.',
      });
    default:
      if (status >= 300 && status < 400) {
        throw new TransportError(`unexpected redirect (HTTP ${status}) for ${apiPath}`, {
          code: 'HTTP_ERROR',
          remedy: 'The REST base URL may be wrong; set "restBase" in the config file.',
        });
      }
      throw new TransportError(`unexpected HTTP ${status} for ${apiPath}`, { code: 'HTTP_ERROR' });
  }
}

/**
 * @typedef {Object} AccountInfo
 * @property {number|null} accountId
 * @property {string|null} name
 * @property {string|null} email
 * @property {string|null} username
 */

/**
 * Authenticate a token against `/a/accounts/self`.
 *
 * This is the "verify before persisting" step: `auth login` calls it before any
 * token reaches storage, so an unverified secret is never written to disk.
 *
 * @param {RestTarget} target
 * @returns {Promise<AccountInfo>}
 */
export async function verifyToken(target) {
  /** @type {any} */
  const account = await restGetJson(target, '/a/accounts/self');
  return {
    accountId: account._account_id ?? null,
    name: account.name ?? null,
    email: account.email ?? null,
    username: account.username ?? null,
  };
}
