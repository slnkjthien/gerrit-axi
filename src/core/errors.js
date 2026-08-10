// SPDX-License-Identifier: Apache-2.0

/**
 * Typed errors for the core library.
 *
 * Core does not render anything, but it does need to say *what* went wrong in a
 * way a caller can branch on. Every error carries a machine-readable `code`;
 * `remedy` is an optional multi-line hint the presentation layer may show. No
 * error ever carries a credential -- see the note in credentials.js.
 */

/** @typedef {'HOST_UNRESOLVED'|'BAD_REMOTE_URL'|'BAD_CONFIG_FILE'|'BAD_SEVERITY_PATTERN'|'NO_CREDENTIAL'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'|'HTTP_ERROR'|'SSH_FAILED'|'UNSAFE_QUERY'|'BAD_RESPONSE'|'GERRIT_ERROR'|'STORE_FAILED'|'NO_TTY'|'EMPTY_TOKEN'} ErrorCode */

export class GerritError extends Error {
  /**
   * @param {string} message
   * @param {{code: ErrorCode, remedy?: string, cause?: unknown}} opts
   */
  constructor(message, { code, remedy, cause } = /** @type {any} */ ({})) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {string|undefined} */
    this.remedy = remedy;
  }
}

/** Host/user/port/project could not be resolved, or config on disk is bad. */
export class ConfigError extends GerritError {}

/** No credential stored, or the server rejected the one we have (401). */
export class AuthError extends GerritError {}

/** The request reached a server but did not succeed (403, 404, 5xx, ssh, ...). */
export class TransportError extends GerritError {}
