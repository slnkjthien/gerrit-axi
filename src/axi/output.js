// SPDX-License-Identifier: Apache-2.0

/**
 * Serialisation, and the one place an error becomes a record.
 *
 * Two formats, one document: TOON by default, strict JSON under `--json`. Both
 * carry the same keys, so a consumer that switches format does not have to
 * relearn the field names.
 *
 * Data goes to stdout; a failure goes to stderr as a typed record and nothing
 * goes to stdout at all. That is the whole point of the split -- a consumer that
 * reads stdout can parse it or fail, never half-parse a sentence of prose, and
 * the exit code says which happened before it reads a byte.
 */

import { AuthError, ConfigError, GerritError, TransportError } from '../core/errors.js';
import { encode } from './toon.js';

/** Bad argv. Raised by args.js, reported like any other typed failure. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    /** @type {string} */
    this.code = 'BAD_USAGE';
  }
}

/**
 * @param {Record<string, unknown>} document
 * @param {{json?: boolean}} [opts]
 * @returns {string}
 */
export function serialize(document, { json = false } = {}) {
  return json ? JSON.stringify(document, null, 2) : encode(document);
}

/**
 * The error record. `code` is the raiser's machine-readable code, `kind` is the
 * class of failure the exit code was chosen from, and `remedy` appears only when
 * core supplied one -- it is a hint for a human reading the log, never a field to
 * branch on.
 *
 * @param {unknown} error
 * @param {{op?: string}} [context]
 * @returns {Record<string, unknown>}
 */
export function errorRecord(error, { op } = {}) {
  const code = /** @type {any} */ (error)?.code;
  /** @type {Record<string, unknown>} */
  const record = {
    ok: false,
    op: op ?? null,
    error: error instanceof Error ? error.message : String(error),
    code: typeof code === 'string' ? code : 'INTERNAL',
    kind: kindOf(error),
  };
  if (error instanceof GerritError && error.remedy) record.remedy = error.remedy;
  return record;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function kindOf(error) {
  if (error instanceof UsageError) return 'usage';
  if (error instanceof ConfigError) return 'config';
  if (error instanceof AuthError) return 'auth';
  if (error instanceof TransportError) return 'transport';
  if (error instanceof GerritError) return 'gerrit';
  return 'internal';
}
