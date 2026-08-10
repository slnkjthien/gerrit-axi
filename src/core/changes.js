// SPDX-License-Identifier: Apache-2.0

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
 * @typedef {{name: string|null, username: string|null, email: string|null}} Account
 */

/**
 * @typedef {Object} LabelVerdict
 * @property {string} name     whatever the server called it
 * @property {string} status   OK | MAY | NEED | REJECT | IMPOSSIBLE | ...
 * @property {boolean} blocking
 * @property {Account|null} by
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
 * @typedef {Object} Vote
 * @property {number} value
 * @property {Account|null} by        who cast it
 * @property {Date|null} grantedOn    when they cast it
 */

/**
 * @typedef {Object} LabelVotes
 * @property {string} name
 * @property {number} max
 * @property {number} min
 * @property {Vote[]} votes
 */

/**
 * @typedef {Object} PatchSet
 * @property {number|null} number
 * @property {string|null} revision    the commit SHA the server has
 * @property {string|null} ref         refs/changes/<nn>/<change>/<patchset>
 * @property {Account|null} uploader
 * @property {Date|null} createdOn
 */

/**
 * A change this one sits on top of, or that sits on top of it.
 *
 * @typedef {Object} Dependency
 * @property {number|null} number
 * @property {string|null} id
 * @property {string|null} revision
 * @property {string|null} ref
 * @property {boolean|null} isCurrentPatchSet  is `revision` still that change's
 *   current patch set? null when the server did not say. False on a `dependsOn`
 *   means this change is stacked on a parent revision that has been superseded.
 */

/**
 * A cover message: what Gerrit calls a change message, and what the web UI shows
 * as the change's conversation -- vote summaries, CI results and their URLs,
 * "Uploaded patch set N". Distinct from the inline comments in comments.js,
 * which live on a file and a line and come over REST.
 *
 * @typedef {Object} ChangeMessage
 * @property {Date|null} timestamp
 * @property {Account|null} author
 * @property {string} message                the body, verbatim
 * @property {number|null} patchSet          best-effort, see deriveMessages
 * @property {string[]} urls                 every URL in the body, in order
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
 * @property {Account|null} owner
 * @property {PatchSet|null} currentPatchSet
 * @property {Readiness} readiness
 * @property {LabelVotes[]} votes          per-label votes on the current patch set
 * @property {Dependency[]} dependsOn      empty unless the query asked for them
 * @property {Dependency[]} neededBy       empty unless the query asked for them
 * @property {ChangeMessage[]} messages    empty unless the query asked for them
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
    entry.votes.push({
      value,
      by: normalizeAccount(approval.by),
      grantedOn: epochToDate(approval.grantedOn),
    });
  }
  for (const entry of byLabel.values()) {
    // Oldest first, so the last vote on a label is the last row a caller sees.
    entry.votes.sort((a, b) => (a.grantedOn?.getTime() ?? 0) - (b.grantedOn?.getTime() ?? 0));
  }
  return [...byLabel.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** URLs a cover message carries -- where a CI result says its log can be read. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`\]]+/g;

/**
 * Gerrit writes its own cover messages and names the patch set in their first
 * line ("Patch Set 7: ...", "Uploaded patch set 8."). That is a convention of the
 * server's message text rather than a field, so this is best-effort by
 * construction: a message that does not say gets null, and nothing downstream may
 * assume otherwise.
 */
const PATCH_SET_IN_MESSAGE = /^\s*(?:uploaded\s+)?patch\s+set\s+(\d+)\b/i;

/**
 * The change's cover messages, oldest first.
 *
 * Present only when the query asked for them; see `DETAIL_QUERY_FLAGS` in ssh.js.
 *
 * @param {any} row
 * @returns {ChangeMessage[]}
 */
export function deriveMessages(row) {
  const list = Array.isArray(row?.comments) ? row.comments : [];
  /** @type {ChangeMessage[]} */
  const messages = [];
  for (const entry of list) {
    const message = typeof entry?.message === 'string' ? entry.message : '';
    const found = PATCH_SET_IN_MESSAGE.exec(message.split('\n', 1)[0] ?? '');
    messages.push({
      timestamp: epochToDate(entry?.timestamp),
      author: normalizeAccount(entry?.reviewer),
      message,
      patchSet: found ? Number(found[1]) : null,
      // Trailing punctuation belongs to the sentence, not to the URL.
      urls: (message.match(URL_IN_TEXT) ?? []).map((url) => url.replace(/[.,;:)]+$/, '')),
    });
  }
  return messages.sort(
    (a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0),
  );
}

/**
 * @param {any} entry
 * @returns {Dependency}
 */
function normalizeDependency(entry) {
  const number = Number(entry?.number);
  return {
    number: Number.isFinite(number) ? number : null,
    id: entry?.id ?? null,
    revision: entry?.revision ?? null,
    ref: entry?.ref ?? null,
    // Tri-state on purpose: "the server did not say" is not "not current".
    isCurrentPatchSet: typeof entry?.isCurrentPatchSet === 'boolean'
      ? entry.isCurrentPatchSet
      : null,
  };
}

/**
 * @param {any} list
 * @returns {Dependency[]}
 */
function normalizeDependencies(list) {
  return (Array.isArray(list) ? list : []).map(normalizeDependency);
}

/**
 * @param {any} account
 * @returns {Account|null}
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
        ref: row.currentPatchSet.ref ?? null,
        uploader: normalizeAccount(row.currentPatchSet.uploader),
        createdOn: epochToDate(row.currentPatchSet.createdOn),
      }
      : null,
    readiness: deriveReadiness(row),
    votes: deriveVotes(row),
    dependsOn: normalizeDependencies(row?.dependsOn),
    neededBy: normalizeDependencies(row?.neededBy),
    messages: deriveMessages(row),
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
 * `sortByLastUpdatedDesc` is available for callers that want newest-first order.
 *
 * `include` names optional detail -- see `DETAIL_QUERY_FLAGS` in ssh.js. It is
 * opt-in because each entry costs the server work per row: a list of a hundred
 * changes has no use for a hundred message timelines.
 *
 * @param {import('./session.js').Session} session
 * @param {QuerySpec|string} spec
 * @param {{limit?: number, include?: readonly string[]}} [opts]
 * @returns {Promise<Change[]>}
 */
export async function queryChanges(session, spec, { limit = 100, include = [] } = {}) {
  const query = typeof spec === 'string' ? spec : buildQuery(spec);
  const { config, runner } = session;
  const { rows } = await sshQuery(
    { host: config.host, port: config.port, user: config.user },
    query,
    { limit, runner, include },
  );
  return rows.filter((row) => row && row.project !== undefined).map(normalizeChange);
}

/**
 * Everything the question "where does this change stand" needs, in one round
 * trip: the current patch set and its revision, who voted and when, the
 * dependencies with their `isCurrentPatchSet` flag, and the cover messages.
 *
 * @param {import('./session.js').Session} session
 * @param {Array<number|string>} numbers
 * @returns {Promise<Change[]>} in the order the server returned them
 */
export function queryChangeDetails(session, numbers) {
  const list = [...numbers];
  return queryChanges(session, { kind: 'changes', numbers: list }, {
    limit: Math.max(1, list.length),
    include: ['comments', 'dependencies'],
  });
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
