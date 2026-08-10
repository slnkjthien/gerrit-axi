// SPDX-License-Identifier: Apache-2.0

/**
 * Rendering. Everything that knows what output *looks like* lives in src/cli/,
 * and this file is where most of it is: column widths, colour, truncation, and
 * the cosmetic project-path shortening.
 *
 * The shortening is derived from the result set rather than configured. Stripping
 * a hardcoded prefix would be wrong on every server but one; here we find whatever
 * prefix the rows actually share and say what we removed. Nothing to configure,
 * nothing to go stale.
 */

/**
 * @param {{env?: NodeJS.ProcessEnv, isTTY?: boolean, forceOff?: boolean}} [opts]
 * @returns {(code: string, text: string) => string}
 */
export function makeColorizer({ env = process.env, isTTY = process.stdout.isTTY, forceOff = false } = {}) {
  const enabled = !forceOff
    && !env.NO_COLOR
    && env.TERM !== 'dumb'
    && (env.FORCE_COLOR ? env.FORCE_COLOR !== '0' : Boolean(isTTY));
  /** @type {Record<string, string>} */
  const codes = {
    reset: '0',
    dim: '2',
    bold: '1',
    red: '31',
    green: '32',
    yellow: '33',
    blue: '34',
    magenta: '35',
    cyan: '36',
  };
  return (code, text) => {
    if (!enabled || !codes[code]) return text;
    return `\u001b[${codes[code]}m${text}\u001b[0m`;
  };
}

/**
 * Longest `/`-delimited path prefix shared by every entry. Returns '' unless at
 * least two entries share at least one whole segment, so a single-row result is
 * never mysteriously abbreviated.
 *
 * @param {string[]} paths
 * @returns {string} the shared prefix, including its trailing slash
 */
export function commonPathPrefix(paths) {
  const list = paths.filter((p) => typeof p === 'string' && p.length > 0);
  if (list.length < 2) return '';
  let shared = list[0].split('/').slice(0, -1); // never swallow the last segment
  for (const p of list.slice(1)) {
    const parts = p.split('/').slice(0, -1);
    let i = 0;
    while (i < shared.length && i < parts.length && shared[i] === parts[i]) i += 1;
    shared = shared.slice(0, i);
    if (shared.length === 0) return '';
  }
  return shared.length ? `${shared.join('/')}/` : '';
}

/**
 * Shorten to `width`, marking the cut with an ellipsis.
 *
 * Not ANSI-aware: apply it to plain text and colour the result, never the other
 * way round, or a slice can land inside an escape sequence. The same goes for a
 * column's `max`, which is applied to the value a column returns.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncate(text, width) {
  const s = String(text ?? '');
  if (width <= 0 || s.length <= width) return s;
  return width <= 1 ? s.slice(0, width) : `${s.slice(0, width - 1)}…`;
}

/**
 * @typedef {Object} Column
 * @property {string} header
 * @property {(row: any) => string} value
 * @property {'left'|'right'} [align]
 * @property {number} [max]   truncate cells wider than this
 */

/**
 * How wide these columns will actually render, including the gaps between them.
 * Used to give the last column whatever terminal width is left over instead of
 * guessing at it.
 *
 * @param {any[]} rows
 * @param {Column[]} columns
 * @param {{gap?: number}} [opts]
 * @returns {number}
 */
export function measureWidth(rows, columns, { gap = 2 } = {}) {
  const widths = columns.map((col) => Math.max(
    col.header.length,
    ...rows.map((row) => {
      const rendered = visibleLength(col.value(row) ?? '');
      return col.max ? Math.min(col.max, rendered) : rendered;
    }),
    0,
  ));
  return widths.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, columns.length - 1);
}

/**
 * Render an aligned table. Returns the lines; printing is the caller's job.
 *
 * @param {any[]} rows
 * @param {Column[]} columns
 * @param {{colorize?: (code: string, text: string) => string, gap?: number}} [opts]
 * @returns {string[]}
 */
export function table(rows, columns, { colorize = (_c, t) => t, gap = 2 } = {}) {
  const cells = rows.map((row) => columns.map((col) => {
    const raw = col.value(row) ?? '';
    return col.max ? truncate(raw, col.max) : String(raw);
  }));
  const widths = columns.map((col, i) => Math.max(
    col.header.length,
    ...cells.map((r) => visibleLength(r[i])),
    0,
  ));
  const sep = ' '.repeat(gap);

  const pad = (/** @type {string} */ text, /** @type {number} */ width, /** @type {'left'|'right'} */ align) => {
    const fill = ' '.repeat(Math.max(0, width - visibleLength(text)));
    return align === 'right' ? fill + text : text + fill;
  };

  const lines = [
    columns.map((col, i) => colorize('dim', pad(col.header, widths[i], col.align ?? 'left')))
      .join(sep)
      .replace(/\s+$/, ''),
  ];
  for (const row of cells) {
    lines.push(
      row.map((cell, i) => pad(cell, widths[i], columns[i].align ?? 'left'))
        .join(sep)
        .replace(/\s+$/, ''),
    );
  }
  return lines;
}

/**
 * Width ignoring ANSI escapes, so pre-coloured cells still align.
 *
 * @param {string} text
 * @returns {number}
 */
export function visibleLength(text) {
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '').length;
}

/**
 * @param {Date|null} date
 * @returns {string}
 */
export function formatDate(date) {
  if (!date) return '-';
  return date.toISOString().slice(0, 10);
}

/**
 * A date and the time of day, UTC like `formatDate`, for the places where "which
 * day" is not precise enough -- two votes on the same afternoon, say.
 *
 * @param {Date|null} date
 * @returns {string}
 */
export function formatDateTime(date) {
  if (!date) return '-';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * How long ago, coarsely. "Did Sean review this, and how long ago" is answered by
 * an order of magnitude, not by a duration to the second.
 *
 * `now` is a parameter so this is testable against a fixed instant rather than
 * against the clock.
 *
 * @param {Date|null} date
 * @param {Date} [now]
 * @returns {string}
 */
export function formatAge(date, now = new Date()) {
  if (!date) return '-';
  const seconds = (now.getTime() - date.getTime()) / 1000;
  if (!Number.isFinite(seconds)) return '-';
  if (seconds < 0) return 'in the future';
  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  if (days < 90) return `${Math.floor(days)}d ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * The leading characters of a revision, enough to compare against a local
 * `git rev-parse` by eye. Never ellipsised: an abbreviated SHA is something you
 * copy, and a `…` in the middle of one is a trap.
 *
 * @param {string|null} revision
 * @param {number} [width]
 * @returns {string}
 */
export function abbreviateRevision(revision, width = 10) {
  if (typeof revision !== 'string' || !revision) return '-';
  return revision.slice(0, width);
}

/**
 * Colour for a submit status. The status itself is the server's word, printed
 * verbatim; only the colour is ours.
 *
 * @param {string} status
 * @param {(code: string, text: string) => string} colorize
 * @returns {string}
 */
export function colorSubmitStatus(status, colorize) {
  switch (status) {
    case 'OK':
      return colorize('green', status);
    case 'RULE_ERROR':
      return colorize('red', status);
    case 'UNKNOWN':
      return colorize('dim', status);
    default:
      return colorize('yellow', status);
  }
}

/**
 * @param {number} value
 * @returns {string}
 */
export function formatVote(value) {
  return value > 0 ? `+${value}` : String(value);
}

/**
 * Terminal width, when there is a terminal.
 *
 * @param {{columns?: number}} [stdout]
 * @returns {number}
 */
export function terminalWidth(stdout = process.stdout) {
  return Number.isFinite(stdout?.columns) ? /** @type {number} */ (stdout.columns) : 100;
}
