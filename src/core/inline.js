// SPDX-License-Identifier: Apache-2.0

/**
 * Posting one inline comment: a new one on a file and line of a change's
 * current patch set, or a reply inside an existing comment thread.
 *
 * Both go through `gerrit review --json`, which reads a ReviewInput from stdin
 * and is the same remote command that can vote. This module and message.js are
 * the only two the source scan in test/layering.test.js lets spell it, and this
 * one is the only module that builds a ReviewInput. `buildReviewInput` assembles
 * it from typed fields -- file, line, text, in_reply_to, unresolved, side --
 * into a fixed shape whose only top-level key is `comments`: there is no
 * parameter for a label, a reviewer, a notify setting or any other field, and
 * nothing in it is ever parsed from a caller. `buildInlineArgs` emits an argv
 * whose only option is `--json`. test/vote-ban.test.js drives both paths and
 * pins what leaves the process, the argv element by element and the payload key
 * by key.
 *
 * Why this command rather than the REST endpoint that also takes a ReviewInput:
 * that endpoint is where votes are recorded, and rest.js exposes no
 * general-purpose write precisely so it cannot be reached by naming a path.
 * Reaching it would mean adding that write. Over ssh the payload travels on the
 * child's stdin, so the text is never a word of any command line, local or
 * remote, and the argv holds nothing a caller chose.
 *
 * Nothing is guessed about where a comment lands. A new comment goes on the
 * current patch set; the file must be in that patch set and the line within
 * the file, both read from the server first. A reply goes on the file, line and
 * patch set of the comment it answers, which must be one the change carries;
 * unless it resolves the thread, it leaves the thread's state as it found it.
 * When a check fails the write is refused, not sent.
 */

import { normalizeComments } from './comments.js';
import { GerritError, TransportError } from './errors.js';
import { assertPostableMessage } from './message.js';
import { assertRestOk, restGetJson, restGetRaw } from './rest.js';
import { buildSshDestination, runSsh, sshFailure } from './ssh.js';

/** ssh's own exit status for a failure to connect or authenticate. */
const SSH_CLIENT_FAILURE = 255;

/** How many of a patch set's files a refusal names before it counts the rest. */
const LISTED_FILES = 40;

/**
 * @typedef {Object} PostedComment
 * @property {number} change
 * @property {number} patchSet       the patch set the comment was posted on
 * @property {string|null} revision  that patch set's commit, when the server named it
 * @property {string|null} project
 * @property {string|null} branch
 * @property {string|null} subject
 * @property {string} file
 * @property {number|null} line      null for a reply to a file- or change-level comment
 * @property {string|null} inReplyTo the comment answered; null for a new comment
 * @property {boolean} unresolved    the thread's state, as sent
 * @property {number} chars          length of the text as sent
 */

/**
 * The ReviewInput, pinned: one key, `comments`, holding one path with one
 * comment, whose fields are the ones named here and no other. `line` and
 * `in_reply_to` are present only when given, `side` only when it is `PARENT`;
 * `message` and `unresolved` always. The text is a JSON string value, so
 * whatever it contains stays text.
 *
 * @param {{file: string, line?: number|null, text: string, unresolved: boolean,
 *          inReplyTo?: string|null, side?: 'PARENT'|'REVISION'|null}} fields
 * @returns {{comments: Record<string, Array<Record<string, string|number|boolean>>>}}
 */
export function buildReviewInput({ file, line = null, text, unresolved, inReplyTo = null, side = null }) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) {
    throw new GerritError('not a file path', { code: 'BAD_RESPONSE' });
  }
  if (line !== null && (!Number.isSafeInteger(line) || line <= 0)) {
    throw new GerritError(`not a line number: ${line}`, { code: 'BAD_RESPONSE' });
  }
  if (typeof unresolved !== 'boolean') {
    throw new GerritError('the thread state must be true or false', { code: 'BAD_RESPONSE' });
  }
  if (inReplyTo !== null && (typeof inReplyTo !== 'string' || inReplyTo === '')) {
    throw new GerritError('not a comment id', { code: 'BAD_RESPONSE' });
  }
  if (side !== null && side !== 'PARENT' && side !== 'REVISION') {
    throw new GerritError(`not a comment side: ${side}`, { code: 'BAD_RESPONSE' });
  }
  const body = assertPostableMessage(text);
  /** @type {Record<string, string|number|boolean>} */
  const comment = {
    ...(line === null ? {} : { line }),
    message: body,
    unresolved,
    ...(inReplyTo === null ? {} : { in_reply_to: inReplyTo }),
    // REVISION is Gerrit's default, so only the other side is spelled.
    ...(side === 'PARENT' ? { side } : {}),
  };
  return { comments: { [file]: [comment] } };
}

/**
 * The argv for ssh, pinned: the destination, then exactly the remote words
 * `gerrit review --json <change>,<patchSet>`. The ReviewInput is not here; it
 * goes on the child's stdin. There is no parameter for any other option.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {number} change
 * @param {number} patchSet
 * @returns {string[]}
 */
export function buildInlineArgs(conn, change, patchSet) {
  if (!Number.isSafeInteger(change) || change <= 0) {
    throw new GerritError(`not a change number: ${change}`, { code: 'BAD_RESPONSE' });
  }
  if (!Number.isSafeInteger(patchSet) || patchSet <= 0) {
    throw new GerritError(`not a patch set number: ${patchSet}`, { code: 'BAD_RESPONSE' });
  }
  return [
    ...buildSshDestination(conn),
    'gerrit', 'review',
    '--json',
    `${change},${patchSet}`,
  ];
}

/**
 * Post one new inline comment on a file and line of a change's current patch
 * set. The thread it opens is unresolved, as a reviewer's new comment is.
 *
 * Three round trips: the change with its current patch set and that patch set's
 * files, so the comment is addressed to the patch set the server has and the
 * file is known to be in it; the file's content, so the line is known to exist;
 * then the post. A change the server does not return is NOT_FOUND; a file the
 * patch set does not list is FILE_NOT_IN_PATCH_SET, with the files it does list;
 * a line past the end, or on a file with no lines to comment on (deleted there,
 * or binary), is LINE_NOT_IN_FILE. A refusal by Gerrit is COMMENT_REFUSED in its
 * own words; ssh's own failure to connect is SSH_FAILED, as everywhere else.
 *
 * @param {import('./session.js').Session} session
 * @param {number|string} change
 * @param {{file: string, line: number, text: string}} comment
 * @returns {Promise<PostedComment>}
 */
export async function postInlineComment(session, change, { file, line, text }) {
  const number = changeNumber(change);
  // Built first: every field is checked before anything is asked of the server.
  const payload = buildReviewInput({ file, line, text, unresolved: true });
  const body = payload.comments[file][0].message;

  const target = await session.restTarget();
  const info = await readChangeInfo(target, number, ['CURRENT_REVISION', 'CURRENT_FILES']);
  const current = currentPatchSet(info, number);
  const entry = current.files[file];
  if (entry === undefined) {
    throw new TransportError(`no such file in patch set ${current.number} of change ${number}: ${file}`, {
      code: 'FILE_NOT_IN_PATCH_SET',
      remedy: `Name the path as the patch set lists it. ${listFiles(Object.keys(current.files), current.number)}`,
    });
  }
  if (entry.status === 'D') {
    throw new TransportError(
      `${file} is deleted in patch set ${current.number} of change ${number}; it has no line to comment on`,
      { code: 'LINE_NOT_IN_FILE' },
    );
  }
  if (entry.binary === true) {
    throw new TransportError(
      `${file} is binary in patch set ${current.number} of change ${number}; it has no line to comment on`,
      { code: 'LINE_NOT_IN_FILE' },
    );
  }
  const lines = await lineCountOf(target, number, current.revision, file);
  if (line > lines) {
    throw new TransportError(
      `line ${line} is past the end of ${file} in patch set ${current.number} of change ${number},`
        + ` which has ${lines} ${lines === 1 ? 'line' : 'lines'}`,
      {
        code: 'LINE_NOT_IN_FILE',
        remedy: lines === 0 ? 'The file is empty in this patch set.' : `Name a line from 1 to ${lines}.`,
      },
    );
  }

  await post(session, number, current.number, payload);
  return {
    change: number,
    patchSet: current.number,
    revision: current.revision,
    project: info.project ?? null,
    branch: info.branch ?? null,
    subject: info.subject ?? null,
    file,
    line,
    inReplyTo: null,
    unresolved: true,
    chars: body.length,
  };
}

/**
 * Post one reply inside the thread of an existing inline comment: on that
 * comment's file, line and patch set, and on its side of the diff. The thread's
 * resolved state is that of its latest comment, and a reply keeps it unless
 * `resolve` is true, which marks the thread resolved.
 *
 * Three round trips: the change with every patch set, so the record can name
 * the commit the thread is on; the change's published comments, so the id is
 * known to be one of them; then the post. A change the server does not return
 * is NOT_FOUND; a comment id it does not carry is NO_SUCH_COMMENT. A draft, or a
 * robot comment, is not among the published comments and reads as missing.
 *
 * @param {import('./session.js').Session} session
 * @param {number|string} change
 * @param {string} commentId
 * @param {{text: string, resolve?: boolean}} reply
 * @returns {Promise<PostedComment>}
 */
export async function replyToComment(session, change, commentId, { text, resolve = false }) {
  const number = changeNumber(change);
  if (typeof commentId !== 'string' || !/^\S+$/.test(commentId) || commentId.includes('\0')) {
    throw new GerritError(`not a comment id: ${commentId}`, { code: 'BAD_RESPONSE' });
  }
  if (typeof resolve !== 'boolean') {
    throw new GerritError('resolve must be true or false', { code: 'BAD_RESPONSE' });
  }
  const body = assertPostableMessage(text);

  const target = await session.restTarget();
  const info = await readChangeInfo(target, number, ['ALL_REVISIONS']);
  const byFile = /** @type {Record<string, any[]>} */ (
    await restGetJson(target, `/a/changes/${number}/comments`)
  );
  const comments = normalizeComments(byFile);
  const parent = comments.find((comment) => comment.id === commentId);
  if (!parent) {
    throw new TransportError(`no such comment on change ${number}: ${commentId}`, {
      code: 'NO_SUCH_COMMENT',
      remedy: 'The id must be one of the published comments on this change;'
        + ' a draft or a robot comment cannot be answered.',
    });
  }
  const patchSet = parent.patchSet;
  if (patchSet === null || !Number.isSafeInteger(patchSet) || patchSet <= 0) {
    throw new TransportError(`comment ${commentId} names no patch set in the server's answer`, {
      code: 'BAD_RESPONSE',
    });
  }
  const unresolved = resolve ? false : threadUnresolved(comments, parent);
  const payload = buildReviewInput({
    file: parent.file,
    line: parent.line,
    text: body,
    unresolved,
    inReplyTo: parent.id,
    side: parent.side,
  });

  await post(session, number, patchSet, payload);
  return {
    change: number,
    patchSet,
    revision: revisionOf(info, patchSet),
    project: info.project ?? null,
    branch: info.branch ?? null,
    subject: info.subject ?? null,
    file: parent.file,
    line: parent.line,
    inReplyTo: parent.id,
    unresolved,
    chars: body.length,
  };
}

/**
 * The resolved state of the thread a comment belongs to: that of the thread's
 * latest comment, which is how Gerrit shows a thread. The thread is the root the
 * comment descends from and everything that descends from that root.
 *
 * @param {readonly import('./comments.js').Comment[]} comments  every comment on the change
 * @param {import('./comments.js').Comment} comment
 * @returns {boolean}
 */
export function threadUnresolved(comments, comment) {
  const byId = new Map(comments.filter((c) => c.id !== null).map((c) => [c.id, c]));
  let root = comment;
  const climbed = new Set();
  while (root.inReplyTo !== null && byId.has(root.inReplyTo) && !climbed.has(root.id)) {
    climbed.add(root.id);
    root = /** @type {import('./comments.js').Comment} */ (byId.get(root.inReplyTo));
  }
  const thread = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < thread.length; i += 1) {
    for (const c of comments) {
      if (c.inReplyTo === thread[i].id && c.id !== null && !seen.has(c.id)) {
        seen.add(c.id);
        thread.push(c);
      }
    }
  }
  const latest = thread.reduce((a, b) => ((b.updated?.getTime() ?? 0) >= (a.updated?.getTime() ?? 0) ? b : a));
  return latest.unresolved;
}

/**
 * How many lines a file has, numbered as Gerrit numbers them: one per newline,
 * plus one for a last line that has none. An empty file has no line.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function lineCount(bytes) {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0a) count += 1;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) count += 1;
  return count;
}

/**
 * @param {number|string} change
 * @returns {number}
 */
function changeNumber(change) {
  const number = Number(change);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new GerritError(`not a change number: ${change}`, { code: 'BAD_RESPONSE' });
  }
  return number;
}

/**
 * The change as REST reports it, with the revision detail asked for. The number
 * is matched, so the record names the change asked about.
 *
 * @param {import('./rest.js').RestTarget} target
 * @param {number} number
 * @param {readonly string[]} options  ListChangesOption names
 * @returns {Promise<any>}
 */
async function readChangeInfo(target, number, options) {
  const query = options.map((option) => `o=${option}`).join('&');
  /** @type {any} */
  const info = await restGetJson(target, `/a/changes/${number}?${query}`);
  if (!info || info._number !== number || typeof info.revisions !== 'object' || info.revisions === null) {
    throw new TransportError(`the server returned no usable state for change ${number}`, { code: 'BAD_RESPONSE' });
  }
  return info;
}

/**
 * @param {any} info
 * @param {number} number
 * @returns {{number: number, revision: string, files: Record<string, any>}}
 */
function currentPatchSet(info, number) {
  const revision = info.current_revision;
  const detail = typeof revision === 'string' ? info.revisions[revision] : undefined;
  if (!detail || !Number.isSafeInteger(detail._number) || detail._number <= 0
    || typeof detail.files !== 'object' || detail.files === null) {
    throw new TransportError(`change ${number} has no current patch set with files in the server's answer`, {
      code: 'BAD_RESPONSE',
    });
  }
  return { number: detail._number, revision, files: detail.files };
}

/**
 * @param {any} info
 * @param {number} patchSet
 * @returns {string|null}
 */
function revisionOf(info, patchSet) {
  const found = Object.entries(info.revisions).find(([, detail]) => /** @type {any} */ (detail)?._number === patchSet);
  return found ? found[0] : null;
}

/**
 * @param {string[]} files
 * @param {number} patchSet
 * @returns {string}
 */
function listFiles(files, patchSet) {
  const named = files.slice(0, LISTED_FILES);
  const rest = files.length - named.length;
  return `Files in patch set ${patchSet}: ${named.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}.`;
}

/**
 * @param {import('./rest.js').RestTarget} target
 * @param {number} number
 * @param {string} revision
 * @param {string} file
 * @returns {Promise<number>}
 */
async function lineCountOf(target, number, revision, file) {
  const apiPath = `/a/changes/${number}/revisions/${revision}/files/${encodeURIComponent(file)}/content`;
  const { status, body } = await restGetRaw(target, apiPath);
  assertRestOk(status, apiPath, target.restBase);
  // The content arrives base64-encoded, whatever the file holds.
  return lineCount(Buffer.from(String(body ?? ''), 'base64'));
}

/**
 * The one write: the pinned argv, with the payload on stdin.
 *
 * @param {import('./session.js').Session} session
 * @param {number} number
 * @param {number} patchSet
 * @param {ReturnType<typeof buildReviewInput>} payload
 */
async function post(session, number, patchSet, payload) {
  const { config, runner } = session;
  const conn = { host: config.host, port: config.port, user: config.user };
  const result = await runSsh(buildInlineArgs(conn, number, patchSet), {
    runner,
    input: JSON.stringify(payload),
  });
  if (result.code === SSH_CLIENT_FAILURE) throw sshFailure(conn, result);
  if (result.code !== 0) {
    const words = String(result.stderr ?? '').trim() || `exit ${result.code}`;
    throw new TransportError(`Gerrit refused the comment on change ${number}: ${words}`, {
      code: 'COMMENT_REFUSED',
    });
  }
}
