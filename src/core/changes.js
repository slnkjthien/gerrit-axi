/**
 * Change models and the readiness oracle.
 *
 * TIER 1: everything here is derived from what the server reports. There is not a
 * single label name in this file. `Verified`, `Code-Review` and `AI-review` are
 * one company's label configuration, not Gerrit's, so hardcoding them would make
 * the tool wrong on the next server it meets -- and wrong on the same server the
 * day someone edits project.config.
 *
 * `gerrit query --submit-records` returns the server's own verdict: an overall
 * `status` plus a per-label `status` of OK / NEED / MAY / REJECT / IMPOSSIBLE.
 * "What is blocking this change" is read straight out of that. We never
 * reconstruct readiness from vote arithmetic; votes are reported alongside, for
 * display, but they are not the oracle.
 *
 * Nothing in this module formats anything. It returns plain objects; src/cli
 * decides what they look like.
 */

import { sshQuery } from './ssh.js';

/**
 * Per-label statuses Gerrit emits in a submit record, ordered from most to least
 * satisfied. Used to combine multiple submit records conservatively.
 *
 * @type {readonly string[]}
 */
const LABEL_STATUS_SEVERITY = ['OK', 'MAY', 'NEED', 'REJECT', 'IMPOSSIBLE'];

/** Label statuses that stop a change from being submittable. */
const BLOCKING_LABEL_STATUSES = new Set(['NEED', 'REJECT', 'IMPOSSIBLE']);

/**
 * @typedef {Object} LabelVerdict
 * @property {string} name     whatever the server called it
 * @property {string} status   OK | MAY | NEED | REJECT | IMPOSSIBLE | ...
 * @property {boolean} blocking
 * @property {{name: string|null, username: string|null, email: string|null}|null} by
 *   the account that satisfied the label, when the server names one
 */

/**
 * @typedef {Object} Readiness
 * @property {string} status         overall submit status as reported (OK,
 *   NOT_READY, RULE_ERROR, CLOSED, FORCED), or "UNKNOWN" when the server sent no
 *   submit record at all
 * @property {boolean} submittable
 * @property {LabelVerdict[]} labels      every label the server mentioned
 * @property {string[]} blocking          names of the labels standing in the way
 * @property {number} recordCount
 * @property {string|null} errorMessage   set when the server reported RULE_ERROR
 */

/**
 * @typedef {Object} LabelVotes
 * @property {string} name
 * @property {number} max
 * @property {number} min
 * @property {Array<{value: number, by: {name: string|null, username: string|null, email: string|null}|null}>} votes
 */

/**
 * @typedef {Object} Change
 * @property {number} number
 * @property {string} id                   Change-Id
 * @property {string} project
 * @property {string} branch
 * @property {string|null} topic
 * @property {string} subject
 * @property {string} status                NEW | MERGED | ABANDONED | ...
 * @property {string|null} url
 * @property {boolean} wip
 * @property {Date|null} createdOn
 * @property {Date|null} lastUpdated
 * @property {{name: string|null, username: string|null, email: string|null}|null} owner
 * @property {{number: number|null, revision: string|null}|null} currentPatchSet
 * @property {Readiness} readiness
 * @property {LabelVotes[]} votes          per-label votes on the current patch set
 * @property {any} raw                     the untouched server row
 */

/**
 * Derive readiness from a change row's submit records.
 *
 * Gerrit may return more than one submit record (different rule evaluators). We
 * combine them conservatively: a label takes its worst reported status, and the
 * overall status is OK only when every record says OK.
 *
 * @param {any} row  a `gerrit query` change row
 * @returns {Readiness}
 */
export function deriveReadiness(row) {
  const records = Array.isArray(row?.submitRecords) ? row.submitRecords : [];

  if (records.length === 0) {
    return {
      status: 'UNKNOWN',
      submittable: false,
      labels: [],
      blocking: [],
      recordCount: 0,
      errorMessage: null,
    };
  }

  /** @type {Map<string, LabelVerdict>} */
  const labels = new Map();
  for (const record of records) {
    for (const label of Array.isArray(record?.labels) ? record.labels : []) {
      const name = label?.label;
      if (typeof name !== 'string' || !name) continue;
      const status = String(label.status ?? 'UNKNOWN');
      const existing = labels.get(name);
      if (existing && severityOf(existing.status) >= severityOf(status)) continue;
      labels.set(name, {
        name,
        status,
        blocking: BLOCKING_LABEL_STATUSES.has(status),
        by: normalizeAccount(label.by),
      });
    }
  }

  const statuses = records.map((r) => String(r?.status ?? 'UNKNOWN'));
  const ruleError = records.find((r) => r?.status === 'RULE_ERROR');
  const status = statuses.includes('RULE_ERROR')
    ? 'RULE_ERROR'
    : statuses.every((s) => s === 'OK')
      ? 'OK'
      : (statuses.find((s) => s !== 'OK') ?? 'UNKNOWN');

  const ordered = [...labels.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    status,
    submittable: status === 'OK',
    labels: ordered,
    blocking: ordered.filter((l) => l.blocking).map((l) => l.name),
    recordCount: records.length,
    errorMessage: ruleError?.errorMessage ?? null,
  };
}

/**
 * @param {string} status
 * @returns {number}
 */
function severityOf(status) {
  const i = LABEL_STATUS_SEVERITY.indexOf(status);
  return i === -1 ? LABEL_STATUS_SEVERITY.length : i; // unknown statuses sort worst
}

/**
 * Collect the votes on the current patch set, grouped by whatever label names the
 * server used. Reported for display only -- readiness comes from submit records.
 *
 * @param {any} row
 * @returns {LabelVotes[]}
 */
export function deriveVotes(row) {
  const approvals = Array.isArray(row?.currentPatchSet?.approvals)
    ? row.currentPatchSet.approvals
    : [];
  /** @type {Map<string, LabelVotes>} */
  const byLabel = new Map();
  for (const approval of approvals) {
    // `type` is the label name; older servers also send `description`.
    const name = approval?.type;
    if (typeof name !== 'string' || !name) continue;
    const value = Number(approval.value);
    if (!Number.isFinite(value)) continue;
    let entry = byLabel.get(name);
    if (!entry) {
      entry = { name, max: value, min: value, votes: [] };
      byLabel.set(name, entry);
    }
    entry.max = Math.max(entry.max, value);
    entry.min = Math.min(entry.min, value);
    entry.votes.push({ value, by: normalizeAccount(approval.by) });
  }
  return [...byLabel.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {any} account
 * @returns {{name: string|null, username: string|null, email: string|null}|null}
 */
function normalizeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  return {
    name: account.name ?? null,
    username: account.username ?? null,
    email: account.email ?? null,
  };
}

/**
 * Turn a raw `gerrit query` row into a typed Change.
 *
 * @param {any} row
 * @returns {Change}
 */
export function normalizeChange(row) {
  return {
    number: Number(row?.number),
    id: row?.id ?? '',
    project: row?.project ?? '',
    branch: row?.branch ?? '',
    topic: row?.topic ?? null,
    subject: row?.subject ?? '',
    status: row?.status ?? 'UNKNOWN',
    url: row?.url ?? null,
    wip: row?.wip === true,
    createdOn: epochToDate(row?.createdOn),
    lastUpdated: epochToDate(row?.lastUpdated),
    owner: normalizeAccount(row?.owner),
    currentPatchSet: row?.currentPatchSet
      ? {
        number: row.currentPatchSet.number === undefined
          ? null
          : Number(row.currentPatchSet.number),
        revision: row.currentPatchSet.revision ?? null,
      }
      : null,
    readiness: deriveReadiness(row),
    votes: deriveVotes(row),
    raw: row,
  };
}

/**
 * @param {unknown} seconds
 * @returns {Date|null}
 */
function epochToDate(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

/**
 * @typedef {{kind: 'attention'}
 *          | {kind: 'mine'}
 *          | {kind: 'changes', numbers: Array<number|string>}
 *          | {kind: 'raw', query: string}} QuerySpec
 */

/**
 * Translate a command-level intent into a Gerrit query string.
 *
 * @param {QuerySpec} spec
 * @returns {string}
 */
export function buildQuery(spec) {
  switch (spec.kind) {
    case 'attention':
      // The caller's attention set: Gerrit's own answer to "your turn".
      return 'attention:self status:open';
    case 'mine':
      return 'owner:self status:open';
    case 'changes': {
      const numbers = spec.numbers.map((n) => {
        const s = String(n).trim();
        if (!/^[0-9]+$/.test(s)) {
          throw new TypeError(`not a change number: ${s}`);
        }
        return `change:${s}`;
      });
      if (numbers.length === 0) throw new TypeError('no change numbers given');
      // Parenthesised so the trailing `limit:` does not bind to the last term.
      return numbers.length === 1 ? numbers[0] : `(${numbers.join(' OR ')})`;
    }
    case 'raw':
      return spec.query.trim();
    default:
      throw new TypeError(`unknown query kind: ${/** @type {any} */ (spec).kind}`);
  }
}

/**
 * Query changes and return typed models. Ordering is left as the server gave it;
 * `sortByLastUpdatedDesc` is available for callers that want the spike's order.
 *
 * @param {import('./session.js').Session} session
 * @param {QuerySpec|string} spec
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Change[]>}
 */
export async function queryChanges(session, spec, { limit = 100 } = {}) {
  const query = typeof spec === 'string' ? spec : buildQuery(spec);
  const { config, runner } = session;
  const { rows } = await sshQuery(
    { host: config.host, port: config.port, user: config.user },
    query,
    { limit, runner },
  );
  return rows.filter((row) => row && row.project !== undefined).map(normalizeChange);
}

/**
 * @param {Change[]} changes
 * @returns {Change[]} a new array, newest first
 */
export function sortByLastUpdatedDesc(changes) {
  return [...changes].sort(
    (a, b) => (b.lastUpdated?.getTime() ?? 0) - (a.lastUpdated?.getTime() ?? 0),
  );
}
