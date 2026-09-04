// SPDX-License-Identifier: Apache-2.0

/**
 * A TOON encoder -- Token-Oriented Object Notation, the wire format the -axi
 * family of agent tools prints by default.
 *
 * It is here rather than from npm because this package has no dependencies,
 * runtime or development. What it emits is the subset of TOON v2 this tier
 * produces: scalars, nested objects, inline primitive arrays, and the tabular
 * array-of-uniform-objects form that carries every table in records.js. Key
 * folding is off, the delimiter is a comma and the indent is two spaces, so
 * output is deterministic and decodes with any conforming reader.
 *
 * The tabular form is why this tier exists. A table declares its own field names
 * in the header -- `labels[3]{change,label,status,blocking,by}:` -- so a consumer
 * reads a value by name. A server that grows a new label adds a row, and no
 * column anywhere moves.
 */

const DELIMITER = ',';
const INDENT = 2;

/** Anything that could be mistaken for a literal or for structure gets quoted. */
const NUMERIC_LIKE = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

/**
 * Encode a JSON-compatible value as TOON. Dates are not accepted: callers
 * convert them, so that the choice of timestamp format stays in records.js.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function encode(value) {
  return lines(value, 0).join('\n');
}

/**
 * @param {unknown} value
 * @param {number} depth
 * @returns {string[]}
 */
function lines(value, depth) {
  if (isPrimitive(value)) return [primitive(value)];
  if (Array.isArray(value)) return arrayLines(undefined, value, depth);
  return objectLines(/** @type {Record<string, unknown>} */ (value), depth);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {number} depth
 * @returns {string[]}
 */
function objectLines(obj, depth) {
  /** @type {string[]} */
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isPrimitive(value)) {
      out.push(indent(depth, `${encodeKey(key)}: ${primitive(value)}`));
    } else if (Array.isArray(value)) {
      out.push(...arrayLines(key, value, depth));
    } else {
      out.push(indent(depth, `${encodeKey(key)}:`));
      const inner = /** @type {Record<string, unknown>} */ (value);
      if (Object.keys(inner).length > 0) out.push(...objectLines(inner, depth + 1));
    }
  }
  return out;
}

/**
 * @param {string|undefined} key
 * @param {unknown[]} items
 * @param {number} depth
 * @returns {string[]}
 */
function arrayLines(key, items, depth) {
  const prefix = key === undefined ? '' : encodeKey(key);
  if (items.length === 0) return [indent(depth, key === undefined ? '[]' : `${prefix}: []`)];

  if (items.every(isPrimitive)) {
    const joined = items.map((v) => primitive(v)).join(DELIMITER);
    return [indent(depth, `${prefix}[${items.length}]: ${joined}`)];
  }

  const fields = tabularFields(items);
  if (fields) {
    const header = `${prefix}[${items.length}]{${fields.map(encodeKey).join(DELIMITER)}}:`;
    return [indent(depth, header), ...tabularRows(items, fields, depth + 1)];
  }

  // Non-uniform members fall back to TOON's list-item form.
  const out = [indent(depth, `${prefix}[${items.length}]:`)];
  for (const item of items) out.push(...listItemLines(item, depth + 1));
  return out;
}

/**
 * One member of a list-item array.
 *
 * @param {unknown} value
 * @param {number} depth
 * @returns {string[]}
 */
function listItemLines(value, depth) {
  if (isPrimitive(value)) return [indent(depth, `- ${primitive(value)}`)];
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) {
      const body = value.length === 0 ? '' : ` ${value.map((v) => primitive(v)).join(DELIMITER)}`;
      return [indent(depth, `- [${value.length}]:${body}`)];
    }
    const out = [indent(depth, `- [${value.length}]:`)];
    for (const item of value) out.push(...listItemLines(item, depth + 1));
    return out;
  }
  return objectAsListItemLines(/** @type {Record<string, unknown>} */ (value), depth);
}

/**
 * An object as a list item: its first entry rides the `- ` marker, the rest are
 * indented one level under it.
 *
 * @param {Record<string, unknown>} obj
 * @param {number} depth
 * @returns {string[]}
 */
function objectAsListItemLines(obj, depth) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return [indent(depth, '-')];
  const [[key, value], ...rest] = entries;
  const marked = firstEntryLines(encodeKey(key), value, depth);
  const tail = rest.length > 0 ? objectLines(Object.fromEntries(rest), depth + 1) : [];
  return [...marked, ...tail];
}

/**
 * @param {string} key   already encoded
 * @param {unknown} value
 * @param {number} depth
 * @returns {string[]}
 */
function firstEntryLines(key, value, depth) {
  if (isPrimitive(value)) return [indent(depth, `- ${key}: ${primitive(value)}`)];
  if (Array.isArray(value)) {
    if (value.length === 0) return [indent(depth, `- ${key}: []`)];
    if (value.every(isPrimitive)) {
      const joined = value.map((v) => primitive(v)).join(DELIMITER);
      return [indent(depth, `- ${key}[${value.length}]: ${joined}`)];
    }
    const fields = tabularFields(value);
    if (fields) {
      const header = `- ${key}[${value.length}]{${fields.map(encodeKey).join(DELIMITER)}}:`;
      return [indent(depth, header), ...tabularRows(value, fields, depth + 2)];
    }
    const out = [indent(depth, `- ${key}[${value.length}]:`)];
    for (const item of value) out.push(...listItemLines(item, depth + 2));
    return out;
  }
  const inner = /** @type {Record<string, unknown>} */ (value);
  const out = [indent(depth, `- ${key}:`)];
  if (Object.keys(inner).length > 0) out.push(...objectLines(inner, depth + 2));
  return out;
}

/**
 * @param {unknown[]} items
 * @param {readonly string[]} fields
 * @param {number} depth
 * @returns {string[]}
 */
function tabularRows(items, fields, depth) {
  return items.map((item) => indent(
    depth,
    fields
      .map((f) => primitive(/** @type {Record<string, unknown>} */ (item)[f]))
      .join(DELIMITER),
  ));
}

/**
 * The field names of an array that can be written in tabular form: every member
 * an object with the same keys in the same order, and every value a primitive.
 *
 * @param {unknown[]} items
 * @returns {string[]|null}
 */
function tabularFields(items) {
  const first = items[0];
  if (!isPlainObject(first)) return null;
  const fields = Object.keys(first);
  if (fields.length === 0) return null;
  for (const item of items) {
    if (!isPlainObject(item)) return null;
    const keys = Object.keys(item);
    if (keys.length !== fields.length) return null;
    for (const field of fields) {
      if (!Object.hasOwn(item, field)) return null;
      if (!isPrimitive(item[field])) return null;
    }
  }
  return fields;
}

/**
 * A scalar. TOON's number is JSON's, which has no NaN and no infinities, so a
 * non-finite one becomes null here rather than the bareword `String()` would
 * give it -- `NaN` unquoted is not a TOON literal, and a consumer would either
 * fail to decode it or silently read it as a string.
 *
 * @param {unknown} value
 * @returns {string}
 */
function primitive(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const text = String(value);
  return safeUnquoted(text) ? text : `"${escape(text)}"`;
}

/**
 * @param {string} key
 * @returns {string}
 */
function encodeKey(key) {
  return /^[A-Za-z_][\w.]*$/.test(key) ? key : `"${escape(key)}"`;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function safeUnquoted(value) {
  if (!value) return false;
  if (value !== value.trim()) return false;
  if (value === 'true' || value === 'false' || value === 'null') return false;
  if (NUMERIC_LIKE.test(value) || /^0\d+$/.test(value)) return false;
  if (value.includes(':') || value.includes('"') || value.includes('\\')) return false;
  if (/[[\]{}]/.test(value)) return false;
  if (/[\u0000-\u001F]/.test(value)) return false;
  if (value.includes(DELIMITER)) return false;
  return !value.startsWith('-');
}

/**
 * @param {string} value
 * @returns {string}
 */
function escape(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\u0000-\u001F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * @param {number} depth
 * @param {string} content
 * @returns {string}
 */
function indent(depth, content) {
  return ' '.repeat(INDENT * depth) + content;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPrimitive(value) {
  return value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
