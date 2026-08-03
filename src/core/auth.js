/**
 * Authentication operations.
 *
 * The credential is a Gerrit authentication token. This layer never sees, and
 * must never be given, an LDAP/domain password -- the refusal and its rationale
 * are part of the CLI's prompt copy, and `--stdin` is documented as taking a
 * token. See credentials.js for the storage invariants.
 *
 * The ordering here is the security-relevant part: verify against the server
 * *first*, persist only on success. An unverified token never reaches disk.
 */

import { verifyToken } from './rest.js';
import { saveToken } from './credentials.js';
import { AuthError, GerritError } from './errors.js';

/**
 * @typedef {Object} LoginResult
 * @property {import('./rest.js').AccountInfo} account
 * @property {import('./credentials.js').StoreResult} store
 */

/**
 * Verify a token, then store it.
 *
 * @param {import('./session.js').Session} session
 * @param {string} token
 * @returns {Promise<LoginResult>}
 */
export async function loginWithToken(session, token) {
  const trimmed = String(token ?? '').trim();
  if (!trimmed) {
    throw new GerritError('no token supplied', {
      code: 'EMPTY_TOKEN',
      remedy: 'Generate one at https://<host>/settings/#HTTPCredentials',
    });
  }

  // Verify before persisting, so a bad token is never written anywhere.
  const account = await verifyToken({
    restBase: session.config.restBase,
    user: session.config.user,
    token: trimmed,
    fetchImpl: session.fetchImpl,
  });

  const store = await saveToken(trimmed, session.credentialId);
  session.rememberToken(trimmed, { backend: store.backend, location: store.location });
  return { account, store };
}

/**
 * @typedef {Object} AuthStatus
 * @property {boolean} stored
 * @property {import('./credentials.js').Backend|null} backend    where the stored credential lives
 * @property {string|null} location
 * @property {boolean} encryptedAtRest
 * @property {import('./credentials.js').Backend} bestBackend     best backend available here
 * @property {boolean} verified
 * @property {import('./rest.js').AccountInfo|null} account
 * @property {{code: string, message: string, remedy: string|null}|null} problem
 */

/**
 * Report whether a stored credential exists and whether it still works.
 *
 * A rejected credential is a *status*, not a crash, so a 401 comes back in
 * `problem` rather than as a thrown error. Anything else (host unreachable,
 * 403, ...) is still thrown -- it says nothing about the credential.
 *
 * @param {import('./session.js').Session} session
 * @returns {Promise<AuthStatus>}
 */
export async function authStatus(session) {
  const bestBackend = await session.bestBackend();
  const stored = await session.peekToken();
  if (!stored) {
    return {
      stored: false,
      backend: null,
      location: null,
      encryptedAtRest: false,
      bestBackend,
      verified: false,
      account: null,
      problem: null,
    };
  }

  const backend = /** @type {import('./credentials.js').Backend} */ (stored.backend);
  const base = {
    stored: true,
    backend,
    location: stored.location,
    encryptedAtRest: backend !== 'file',
    bestBackend,
  };

  try {
    const account = await verifyToken({
      restBase: session.config.restBase,
      user: session.config.user,
      token: stored.token,
      fetchImpl: session.fetchImpl,
    });
    return { ...base, verified: true, account, problem: null };
  } catch (err) {
    if (err instanceof AuthError && err.code === 'UNAUTHORIZED') {
      return {
        ...base,
        verified: false,
        account: null,
        problem: { code: err.code, message: err.message, remedy: err.remedy ?? null },
      };
    }
    throw err;
  }
}

/**
 * Remove the stored credential from every backend holding one.
 *
 * @param {import('./session.js').Session} session
 * @returns {Promise<{removed: import('./credentials.js').Backend[]}>}
 */
export function logout(session) {
  return session.forgetToken();
}

/**
 * Where the user generates a token for this server. Derived from the resolved
 * host -- no hostname is baked in anywhere.
 *
 * @param {import('./session.js').Session} session
 * @returns {string}
 */
export function tokenSettingsUrl(session) {
  return `${session.config.restBase}/settings/#HTTPCredentials`;
}
