// SPDX-License-Identifier: Apache-2.0

/**
 * The tier's operations. Each one builds a document out of core models and hands
 * it back; main.js serialises it.
 *
 * Every operation that names changes takes a list of them and answers about all
 * of them in one call. That is the requirement this tier was built for: a watch
 * following a nine-change stack must not need nine invocations, and `gerrit
 * query` answers about a whole list in one round trip anyway.
 */

import { authStatus } from '../core/auth.js';
import { queryChanges, sortByLastUpdatedDesc } from '../core/changes.js';
import { listComments } from '../core/comments.js';
import { changeNumbers, messageCount, positiveInt } from './args.js';
import {
  changeRow,
  commentRows,
  dependencyRows,
  labelRows,
  messageRows,
  voteRows,
} from './records.js';
import { UsageError } from './output.js';

/**
 * @typedef {Object} Ctx
 * @property {import('../core/session.js').Session} session
 * @property {import('./args.js').ParsedArgs} args
 */

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
