// SPDX-License-Identifier: Apache-2.0

/**
 * The tier's operations. Each one builds a document out of core models and hands
 * it back; main.js serialises it.
 *
 * Every read that names changes takes a list of them and answers about all of
 * them in one call. That is the requirement this tier was built for: a watch
 * following a nine-change stack must not need nine invocations, and `gerrit
 * query` answers about a whole list in one round trip anyway.
 *
 * The two writes are `publish` and `submit`, and there is no third: nothing here
 * records a vote, comments, or sets reviewers.
 */

import { authStatus } from '../core/auth.js';
import {
  buildQuery,
  queryChangePage,
  queryChanges,
  sortByLastUpdatedDesc,
} from '../core/changes.js';
import { listComments } from '../core/comments.js';
import { publishChanges } from '../core/publish.js';
import { submitChange } from '../core/submit.js';
import { changeNumbers, messageCount, positiveInt } from './args.js';
import {
  changeRow,
  commentRows,
  dependencyRows,
  entryRow,
  labelRows,
  messageRows,
  publishedRow,
  sectionRow,
  voteRows,
} from './records.js';
import { UsageError } from './output.js';

/**
 * @typedef {Object} Ctx
 * @property {import('../core/session.js').Session} session
 * @property {import('./args.js').ParsedArgs} args
 */

/** Rows the dashboard shows per section unless `--rows` says otherwise. */
const DASHBOARD_ROWS = 10;

/**
 * How many changes each dashboard query fetches. Also the ceiling on `--rows`:
 * past it a section's `count` would be the fetch limit rather than the truth.
 */
const DASHBOARD_FETCH_LIMIT = 100;

/**
 * `dashboard` -- the home view, and what a bare `gerrit-axi` prints: the
 * caller's open changes grouped the way Gerrit's own dashboard groups them.
 * Your turn, work in progress, outgoing, incoming, CCed on.
 *
 * Four round trips, one per question the server can answer in a single
 * `gerrit query`: a query row carries neither the attention set nor whether the
 * caller is a reviewer or a CC, so the sections cannot be split locally from one
 * OR'd query. The owner query is the exception -- `wip` is on the row -- so work
 * in progress and outgoing reviews come from the same call. The four run one at
 * a time, as `comments` does, rather than opening four sockets at once against
 * someone's review server.
 *
 * Every section row is always present. Nothing awaiting you is a fact worth a
 * row, not a table to omit.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opDashboard({ session, args }) {
  const { positional, flags } = args;
  if (positional.length > 0) {
    throw new UsageError(`dashboard takes no arguments (got: ${positional.join(' ')})`);
  }
  const rows = positiveInt(flags['--rows'], DASHBOARD_ROWS, '--rows');
  if (rows < 1 || rows > DASHBOARD_FETCH_LIMIT) {
    throw new UsageError(`--rows must be between 1 and ${DASHBOARD_FETCH_LIMIT}, got: ${rows}`);
  }

  const fetch = (/** @type {import('../core/changes.js').QuerySpec} */ spec) => (
    queryChangePage(session, spec, { limit: DASHBOARD_FETCH_LIMIT })
  );
  const attention = await fetch({ kind: 'attention' });
  const own = await fetch({ kind: 'mine' });
  const incoming = await fetch({ kind: 'incoming' });
  const cced = await fetch({ kind: 'cced' });

  const mine = buildQuery({ kind: 'mine' });
  const sections = [
    dashboardSection('your_turn', buildQuery({ kind: 'attention' }), attention, rows),
    dashboardSection('wip', `${mine} is:wip`, {
      changes: own.changes.filter((change) => change.wip),
      more: own.more,
    }, rows),
    dashboardSection('outgoing', `${mine} NOT is:wip`, {
      changes: own.changes.filter((change) => !change.wip),
      more: own.more,
    }, rows),
    dashboardSection('incoming', buildQuery({ kind: 'incoming' }), incoming, rows),
    dashboardSection('cced', buildQuery({ kind: 'cced' }), cced, rows),
  ];
  const distinct = new Set(sections.flatMap((s) => s.changes.map((change) => change.number)));

  return {
    ok: true,
    op: 'dashboard',
    user: session.config.user,
    host: session.config.host,
    total: distinct.size,
    sections: sections.map(sectionRow),
    entries: sections.flatMap((s) => s.kept.map((change) => entryRow(s.name, change))),
    help: dashboardHelp(sections, distinct.size),
  };
}

/**
 * @typedef {Object} DashboardSection
 * @property {string} name
 * @property {string} query        reproduces the section on its own
 * @property {import('../core/changes.js').Change[]} changes  all matched, newest first
 * @property {import('../core/changes.js').Change[]} kept     the rows shown
 * @property {number} count
 * @property {number} shown
 * @property {boolean} more        this tier or the server held rows back
 * @property {boolean} serverMore  the server did, so `count` is a floor
 */

/**
 * @param {string} name
 * @param {string} query
 * @param {import('../core/changes.js').ChangePage} page
 * @param {number} rows
 * @returns {DashboardSection}
 */
function dashboardSection(name, query, page, rows) {
  const changes = sortByLastUpdatedDesc(page.changes);
  const kept = changes.slice(0, rows);
  return {
    name,
    query,
    changes,
    kept,
    count: changes.length,
    shown: kept.length,
    more: page.more || kept.length < changes.length,
    serverMore: page.more,
  };
}

/**
 * The next step, named: what to run for what awaits you, where the rest of a
 * truncated section is, and how to start when nothing of yours is open. One
 * line per point at most, and none when nothing applies.
 *
 * @param {DashboardSection[]} sections
 * @param {number} total
 * @returns {string[]}
 */
function dashboardHelp(sections, total) {
  const by = Object.fromEntries(sections.map((s) => [s.name, s]));
  /** @type {string[]} */
  const help = [];
  if (total === 0) {
    help.push('No open change involves you.');
  } else if (by.your_turn.count === 0) {
    help.push('Nothing awaits your attention.');
  } else {
    const numbers = by.your_turn.kept.map((change) => change.number).join(' ');
    help.push(`Run \`gerrit-axi show ${numbers} --comments\` for the full state of what awaits you`);
  }
  for (const s of sections) {
    if (!s.more) continue;
    const matched = `${s.count}${s.serverMore ? '+' : ''} matched, ${s.shown} shown`;
    help.push(`Run \`gerrit-axi status --query '${s.query}'\` for every ${s.name} change (${matched})`);
  }
  if (by.wip.count === 0 && by.outgoing.count === 0) {
    help.push('Run `gerrit-axi publish --stack --topic <t>` or `gerrit-axi publish --squash` to propose the commits on HEAD');
  }
  return help;
}

/**
 * `status` -- the list view: the attention set, your own changes, named changes,
 * or a raw Gerrit query. Newest first, matching what the question "what changed"
 * wants.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opStatus({ session, args }) {
  const { positional, flags } = args;
  const raw = flags['--query'];
  /** @type {import('../core/changes.js').QuerySpec} */
  let spec;
  if (typeof raw === 'string') {
    if (positional.length > 0) {
      throw new UsageError('--query takes the whole query; drop the positional arguments');
    }
    spec = { kind: 'raw', query: raw };
  } else if (positional.length === 0) {
    spec = { kind: 'attention' };
  } else if (positional.length === 1 && positional[0] === 'mine') {
    spec = { kind: 'mine' };
  } else {
    spec = { kind: 'changes', numbers: changeNumbers(positional) };
  }

  const limit = positiveInt(flags['--limit'], 100, '--limit');
  const changes = sortByLastUpdatedDesc(await queryChanges(session, spec, { limit }));

  return {
    ok: true,
    op: 'status',
    count: changes.length,
    changes: changes.map(changeRow),
    labels: changes.flatMap(labelRows),
    votes: changes.flatMap(voteRows),
  };
}

/**
 * `show` -- the full review state of every change named, in the order they were
 * named so a caller can zip the result against its own list. Change numbers the
 * server did not return come back under `missing` rather than as a failure: a
 * watch needs to tell "abandoned or no longer visible" apart from "the call
 * broke".
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opShow({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length === 0) throw new UsageError('show needs at least one change number');

  const keep = messageCount(args.flags['--messages']);
  const wantComments = args.flags['--comments'] === true;
  // The cover messages cost the server work per row, so they are only asked for
  // when they will be emitted. The stack is always asked for: a stale parent
  // revision is the thing a stack watch exists to notice.
  const include = keep > 0 ? ['comments', 'dependencies'] : ['dependencies'];

  const found = await queryChanges(session, { kind: 'changes', numbers }, {
    limit: numbers.length,
    include,
  });
  const byNumber = new Map(found.map((change) => [change.number, change]));
  const changes = numbers
    .map((number) => byNumber.get(number))
    .filter((change) => change !== undefined);

  /** @type {Record<string, unknown>} */
  const document = {
    ok: true,
    op: 'show',
    count: changes.length,
    missing: numbers.filter((number) => !byNumber.has(number)),
    changes: changes.map(changeRow),
    labels: changes.flatMap(labelRows),
    votes: changes.flatMap(voteRows),
    depends_on: changes.flatMap((change) => dependencyRows(change, 'dependsOn')),
    needed_by: changes.flatMap((change) => dependencyRows(change, 'neededBy')),
  };
  if (keep > 0) {
    document.messages = changes.flatMap((change) => messageRows(change, keep));
  }
  if (wantComments) {
    document.comments = await gatherComments(session, changes.map((c) => c.number), args.flags);
  }
  return document;
}

/**
 * `comments` -- the inline comments on every change named. These are the ones a
 * reviewer actually writes against a line; the SSH cover messages do not carry
 * them, so this is the only path that reaches them.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opComments({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length === 0) throw new UsageError('comments needs at least one change number');
  const rows = await gatherComments(session, numbers, args.flags);
  return { ok: true, op: 'comments', count: rows.length, comments: rows };
}

/**
 * One REST call per change, sequentially: a watch over a stack should not open
 * nine sockets at once against someone's review server.
 *
 * @param {import('../core/session.js').Session} session
 * @param {readonly number[]} numbers
 * @param {Record<string, string|boolean>} flags
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function gatherComments(session, numbers, flags) {
  const botsOnly = flags['--bots'] === true;
  const humansOnly = flags['--humans'] === true;
  if (botsOnly && humansOnly) throw new UsageError('--bots and --humans exclude each other');

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  for (const number of numbers) {
    const comments = await listComments(session, number, { botsOnly, humansOnly });
    rows.push(...commentRows(number, comments));
  }
  return rows;
}

/**
 * `auth status` -- whether the stored credential still works. Without it a
 * consumer cannot tell an expired token from a change with no comments except by
 * reading an error string, which is exactly what this tier exists to avoid.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opAuth({ session, args }) {
  const [sub = 'status'] = args.positional;
  if (sub !== 'status') {
    throw new UsageError(`auth ${sub} is not part of this tier; use 'gerrit auth ${sub}'`);
  }
  const status = await authStatus(session);
  return {
    ok: true,
    op: 'auth status',
    stored: status.stored,
    verified: status.verified,
    backend: status.backend,
    encrypted_at_rest: status.encryptedAtRest,
    best_backend: status.bestBackend,
    account: status.account?.username ?? status.account?.name ?? null,
    problem: status.problem?.code ?? null,
    host: session.config.host,
    user: session.config.user,
  };
}

/**
 * `publish` -- the commits on HEAD, proposed to a branch as changes: one change
 * per commit under a topic with `--stack`, or one change for all of them with
 * `--squash`. The shape is the caller's to name, never guessed; a single commit
 * publishes identically either way, but a caller that meant one and got the
 * other would have created changes it has to abandon.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opPublish({ session, args }) {
  const { positional, flags } = args;
  if (positional.length > 0) {
    throw new UsageError(`publish takes no arguments; it publishes HEAD (got: ${positional.join(' ')})`);
  }
  const stack = flags['--stack'] === true;
  const squash = flags['--squash'] === true;
  if (stack === squash) throw new UsageError('publish needs exactly one of --stack or --squash');
  const topic = typeof flags['--topic'] === 'string' ? flags['--topic'] : null;
  // A stack is addressed as a unit through its topic; without one it is only a
  // chain of changes that happen to depend on each other.
  if (stack && topic === null) throw new UsageError('publish --stack needs --topic <name>');
  if (squash && topic !== null) throw new UsageError('publish --squash takes no --topic; a topic names a stack');
  const branch = typeof flags['--branch'] === 'string' ? flags['--branch'] : null;

  const publication = await publishChanges(session, {
    shape: stack ? 'stack' : 'squash',
    branch,
    topic,
  });
  const changes = publication.published
    .map((entry) => entry.change)
    .filter((change) => change !== null);
  return {
    ok: true,
    op: 'publish',
    shape: publication.shape,
    branch: publication.branch,
    topic: publication.topic,
    base: publication.base,
    commit: publication.commit,
    new_patch_sets: publication.newPatchSets,
    head: publication.head,
    rewritten_from: publication.rewrittenFrom,
    count: publication.published.length,
    published: publication.published.map(publishedRow),
    changes: changes.map(changeRow),
  };
}

/**
 * `submit` -- ask the server to submit one change. One, because the server
 * already decides what must go in with it -- the changes it depends on, or the
 * rest of its topic -- and submits those together or not at all; a list here
 * would only invent an order between separate transactions.
 *
 * Nothing is checked first. A refusal is the server's, in its own words, and
 * arrives as an error record with code SUBMIT_REFUSED.
 *
 * @param {Ctx} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function opSubmit({ session, args }) {
  const numbers = changeNumbers(args.positional);
  if (numbers.length !== 1) {
    throw new UsageError('submit takes exactly one change; the server submits what must go with it');
  }
  const submitted = await submitChange(session, numbers[0]);
  return {
    ok: true,
    op: 'submit',
    change: submitted.number,
    status: submitted.status,
    change_id: submitted.changeId,
    project: submitted.project,
    branch: submitted.branch,
    topic: submitted.topic,
    subject: submitted.subject,
  };
}
