// SPDX-License-Identifier: Apache-2.0

/**
 * Serialisation, and the one place an error becomes a record.
 *
 * Two formats, one document: TOON by default, strict JSON under `--json`. Both
 * carry the same keys, so a consumer that switches format does not have to
 * relearn the field names.
 *
 * Everything goes to stdout, a failure included, as a typed record with `ok`
 * false in the same format as the data: a consumer reads one stream, parses one
 * document, and branches on `ok` and the exit code, never on a sentence of prose.
 * stderr carries nothing, so a caller that captures stdout has the reason a call
 * failed rather than an empty string.
 */

import { AuthError, ConfigError, GerritError, TransportError } from '../core/errors.js';
import { encode } from './toon.js';

/**
 * Bad argv. Raised by args.js and main.js, reported like any other typed failure.
 * `remedy` is what to run instead -- the valid options -- so the
 * caller corrects in one turn rather than after a `--help`.
 */
export class UsageError extends Error {
  /**
   * @param {string} message
   * @param {string} [remedy]
   */
  constructor(message, remedy) {
    super(message);
    this.name = 'UsageError';
    /** @type {string} */
    this.code = 'BAD_USAGE';
    /** @type {string|undefined} */
    this.remedy = remedy;
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
 * the raiser supplied one -- core for a server-side failure, the parser for a
 * usage one. It is a hint for whoever reads the log, never a field to branch on.
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
  if ((error instanceof GerritError || error instanceof UsageError) && error.remedy) {
    record.remedy = error.remedy;
  }
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
