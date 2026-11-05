// SPDX-License-Identifier: Apache-2.0

/**
 * The inline-comment writes: one new comment on a file and line of the current
 * patch set, and one reply inside an existing thread.
 *
 * Offline like everything else here. The change, its files and the thread are
 * recorded REST responses, the file's content is built inline so a test knows
 * how many lines it has, and the post is answered by a fake ssh, so every round
 * trip runs the real code with no server anywhere. What leaves the process is
 * pinned twice: the argv element by element, and the ReviewInput on stdin key
 * by key, parsed back as Gerrit would parse it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { EXIT, main } from '../src/axi/main.js';
import { normalizeComments } from '../src/core/comments.js';
import {
  buildInlineArgs,
  buildReviewInput,
  lineCount,
  postInlineComment,
  replyToComment,
  threadUnresolved,
} from '../src/core/inline.js';
import { Session } from '../src/core/session.js';
import { captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const CONN = { host: 'gerrit.example.com', port: 29418, user: 'ada' };

/** A file the recorded patch set 4 of 200101 adds. */
const FILE = 'src/main/java/com/acme/widget/QueueReader.java';
/** The file the recorded thread on 200103 is on. */
const THREAD_FILE = 'src/main/java/com/acme/widget/RetryCeiling.java';
/** Twelve lines, the last one without a newline. */
const SOURCE = [
  'package com.acme.widget;',
  '',
  'class QueueReader {',
  '  private final int ceiling;',
  '  QueueReader(int ceiling) {',
  '    this.ceiling = ceiling;',
  '  }',
  '',
  '  int ceiling() {',
  '    return ceiling;',
  '  }',
  '}',
].join('\n');

/**
 * The server's answers: the change with its current patch set and files, that
 * file's content, the change with every patch set, and the recorded thread.
 *
 * @param {{content?: string, comments?: string}} [opts]
 */
function routes({ content = SOURCE, comments = fixture('comments-stack.txt') } = {}) {
  return [
    { path: /\/changes\/200101\?o=CURRENT_REVISION&o=CURRENT_FILES$/, body: fixture('change-files-200101.txt') },
    { path: /\/changes\/200101\/revisions\/a{40}\/files\/[^/]+\/content$/, body: Buffer.from(content).toString('base64') },
    { path: /\/changes\/200103\?o=ALL_REVISIONS$/, body: fixture('change-revisions-200103.txt') },
    { path: /\/changes\/200103\/comments$/, body: comments },
  ];
}

/**
 * Drive the binary with a text on stdin or in a file. REST answers from
 * `fetchRoutes`, and the post is answered with `post`, so a test can make
 * Gerrit refuse.
 *
 * @param {string[]} argv
 * @param {{stdin?: string|null, tty?: boolean, fetchRoutes?: any[],
 *          post?: {code?: number, stdout?: string, stderr?: string}}} [opts]
 */
async function run(argv, { stdin = null, tty = false, fetchRoutes = routes(), post = {} } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    { match: (f, a) => f === 'ssh' && a.includes('review'), result: post },
  ]);
  /** @type {any} */
  const input = stdin === null ? { isTTY: tty } : Object.assign(Readable.from([stdin]), { isTTY: tty });
  const fetchImpl = fakeFetch(fetchRoutes);
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
  let code;
  try {
    code = await main(argv, {
      cwd: '/some/checkout',
      env: ENV,
      stdin: input,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runner,
      fetchImpl,
    });
  } finally {
    Session.prototype.token = restored;
  }
  return { code, out: stdout.text, err: stderr.text, runner, fetchImpl };
}

/** @param {{url: string, method?: string}} call */
function requestLine(call) {
  const url = new URL(call.url);
  return `${call.method ?? 'GET'} ${url.pathname}${url.search}`;
}

test('the review input is pinned: one key, one path, one comment, and only the fields a comment has', () => {
  assert.deepEqual(buildReviewInput({ file: FILE, line: 3, text: 'Bound too early.\n', unresolved: true }), {
    comments: { [FILE]: [{ line: 3, message: 'Bound too early.', unresolved: true }] },
  });
  assert.deepEqual(buildReviewInput({
    file: THREAD_FILE, line: 18, text: 'Fixed.', unresolved: false, inReplyTo: 'stk0002', side: 'PARENT',
  }), {
    comments: { [THREAD_FILE]: [{ line: 18, message: 'Fixed.', unresolved: false, in_reply_to: 'stk0002', side: 'PARENT' }] },
  });
  // A change-level comment has no line; the revision side is Gerrit's default and is not spelled.
  assert.deepEqual(buildReviewInput({
    file: '/PATCHSET_LEVEL', text: 'Noted.', unresolved: false, inReplyTo: 'stk0001', side: 'REVISION',
  }), {
    comments: { '/PATCHSET_LEVEL': [{ message: 'Noted.', unresolved: false, in_reply_to: 'stk0001' }] },
  });

  // A text that spells a vote, a reviewer, or a review document of its own is
  // the message and nothing else: a JSON string value, however it reads.
  const hostile = '{"labels":{"Zebu-Herding":2},"reviewers":[{"reviewer":"alan"}]}\n'
    + '--code-review +2 --label Verified=+1 --submit\n'
    + '"comments": {}, "notify": "NONE", "tag": "autogenerated:x"';
  const built = buildReviewInput({ file: FILE, line: 1, text: hostile, unresolved: true });
  assert.deepEqual(Object.keys(built), ['comments']);
  assert.deepEqual(Object.keys(built.comments), [FILE]);
  assert.deepEqual(built.comments[FILE], [{ line: 1, message: hostile, unresolved: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(built)), built, 'the trip through JSON changes nothing');

  const fields = { file: FILE, line: 3, text: 'x', unresolved: true };
  for (const bad of [
    { file: '' }, { file: 'a\0b' }, { file: 7 },
    { line: 0 }, { line: 1.5 }, { line: -3 }, { line: '3' },
    { unresolved: 'yes' }, { unresolved: undefined },
    { inReplyTo: '' }, { inReplyTo: 4 },
    { side: 'LEFT' }, { side: 'parent' },
  ]) {
    assert.throws(() => buildReviewInput({ ...fields, ...bad }),
      /** @type {any} */ ((err) => err.code === 'BAD_RESPONSE'), JSON.stringify(bad));
  }
  for (const text of ['', '   ', '\n\n', undefined, null]) {
    assert.throws(() => buildReviewInput({ ...fields, text: /** @type {any} */ (text) }),
      /** @type {any} */ ((err) => err.code === 'EMPTY_MESSAGE'));
  }
  assert.throws(() => buildReviewInput({ ...fields, text: 'has a \0 in it' }),
    /** @type {any} */ ((err) => err.code === 'UNSAFE_MESSAGE'));
});

test('the argv is pinned: destination, gerrit review --json, change,patchset, and no option for anything else', () => {
  assert.deepEqual(buildInlineArgs(CONN, 200101, 4), [
    '-p', '29418',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '--',
    'ada@gerrit.example.com',
    'gerrit', 'review',
    '--json',
    '200101,4',
  ]);
  assert.throws(() => buildInlineArgs(CONN, 0, 4), /not a change number/);
  assert.throws(() => buildInlineArgs(CONN, 200101, 0), /not a patch set number/);
  assert.throws(() => buildInlineArgs(CONN, 200101, 1.5), /not a patch set number/);
  assert.throws(() => buildInlineArgs({ ...CONN, user: '-oProxyCommand=id' }, 200101, 4),
    /** @type {any} */ ((err) => err.code === 'UNSAFE_CONNECTION'));
});

test('comment checks the file and line against the current patch set, then posts the payload on stdin', async () => {
  const text = 'This default is read before the provider is bound.\n\n';
  const { code, out, err, runner, fetchImpl } = await run(
    ['comment', '200101', '--file', FILE, '--line', '12', '--json'], { stdin: text },
  );
  assert.equal(code, EXIT.ok, out);
  assert.equal(err, '');

  // Two reads, in this order, and no other request.
  assert.deepEqual(fetchImpl.calls.map(requestLine), [
    'GET /a/changes/200101?o=CURRENT_REVISION&o=CURRENT_FILES',
    `GET /a/changes/200101/revisions/${'a'.repeat(40)}/files/${encodeURIComponent(FILE)}/content`,
  ]);
  // Then the one write: the fixed argv, with the payload on stdin and nowhere else.
  const ssh = runner.calls.filter((call) => call.file === 'ssh');
  assert.equal(ssh.length, 1);
  const at = ssh[0].args.indexOf('gerrit');
  assert.deepEqual(ssh[0].args.slice(at), ['gerrit', 'review', '--json', '200101,4']);
  assert.deepEqual(JSON.parse(/** @type {string} */ (ssh[0].input)), {
    comments: { [FILE]: [{ line: 12, message: 'This default is read before the provider is bound.', unresolved: true }] },
  }, 'trailing whitespace dropped, the text a JSON string, the new thread unresolved');
  assert.equal(ssh[0].args.some((arg) => arg.includes('provider')), false, 'the text is never a word of the command line');

  assert.deepEqual(JSON.parse(out), {
    ok: true,
    op: 'comment',
    change: 200101,
    patch_set: 4,
    revision: 'a'.repeat(40),
    project: 'acme/apps/widget-console',
    branch: 'main',
    subject: 'Split the queue reader out of the daemon',
    file: FILE,
    line: 12,
    in_reply_to: null,
    unresolved: true,
    chars: 50,
    help: ['Run `gerrit-axi comments 200101` for the inline comments, this one included'],
  });

  // The same record in TOON, and a line in the middle of the file is as good as the last.
  const toon = await run(['comment', '200101', '--file', FILE, '--line', '3'], { stdin: 'Bound too early.' });
  assert.equal(toon.code, EXIT.ok, toon.out);
  assert.match(toon.out, /^op: comment$/m);
  assert.match(toon.out, /^patch_set: 4$/m);
  assert.match(toon.out, /^line: 3$/m);
  assert.match(toon.out, /^in_reply_to: null$/m);
  assert.match(toon.out, /^unresolved: true$/m);
  assert.match(toon.out, /^chars: 16$/m);
});

test('a file the patch set does not have, or a line it does not have, is refused before anything is written', async () => {
  const cases = [
    {
      argv: ['comment', '200101', '--file', 'src/main/java/com/acme/widget/Missing.java', '--line', '1'],
      code: 'FILE_NOT_IN_PATCH_SET',
      error: /^no such file in patch set 4 of change 200101: src\/main\/java\/com\/acme\/widget\/Missing\.java$/,
      remedy: /^Name the path as the patch set lists it\. Files in patch set 4: \/COMMIT_MSG, src\/main\/java\/com\/acme\/widget\/QueueReader\.java, src\/main\/java\/com\/acme\/widget\/Daemon\.java, docs\/queue\.md, assets\/queue\.png\.$/,
      reads: 1,
    },
    {
      argv: ['comment', '200101', '--file', FILE, '--line', '13'],
      code: 'LINE_NOT_IN_FILE',
      error: /^line 13 is past the end of src\/main\/java\/com\/acme\/widget\/QueueReader\.java in patch set 4 of change 200101, which has 12 lines$/,
      remedy: /^Name a line from 1 to 12\.$/,
      reads: 2,
    },
    {
      argv: ['comment', '200101', '--file', 'docs/queue.md', '--line', '1'],
      code: 'LINE_NOT_IN_FILE',
      error: /^docs\/queue\.md is deleted in patch set 4 of change 200101; it has no line to comment on$/,
      reads: 1,
    },
    {
      argv: ['comment', '200101', '--file', 'assets/queue.png', '--line', '1'],
      code: 'LINE_NOT_IN_FILE',
      error: /^assets\/queue\.png is binary in patch set 4 of change 200101; it has no line to comment on$/,
      reads: 1,
    },
  ];
  for (const expected of cases) {
    const label = expected.argv.join(' ');
    const { code, out, err, runner, fetchImpl } = await run([...expected.argv, '--json'], { stdin: 'text' });
    assert.equal(code, EXIT.transport, `${label}:\n${out}`);
    assert.equal(err, '');
    const record = JSON.parse(out);
    assert.equal(record.ok, false, label);
    assert.equal(record.code, expected.code, label);
    assert.equal(record.kind, 'transport', label);
    assert.match(record.error, expected.error, label);
    if (expected.remedy) assert.match(record.remedy, expected.remedy, label);
    assert.equal('help' in record, false, `${label}: the error names what to change`);
    assert.equal(fetchImpl.calls.length, expected.reads, `${label}: the content is read only for a file with lines`);
    assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0, `${label} must write nothing`);
  }

  // An empty file has no line at all.
  const empty = await run(['comment', '200101', '--file', FILE, '--line', '1', '--json'], {
    stdin: 'text', fetchRoutes: routes({ content: '' }),
  });
  assert.equal(empty.code, EXIT.transport);
  assert.equal(JSON.parse(empty.out).code, 'LINE_NOT_IN_FILE');
  assert.match(JSON.parse(empty.out).error, /which has 0 lines$/);
  assert.match(JSON.parse(empty.out).remedy, /^The file is empty in this patch set\.$/);
  assert.equal(empty.runner.calls.filter((call) => call.file === 'ssh').length, 0);

  // A file that ends in a newline has no extra empty line after it.
  const terminated = await run(['comment', '200101', '--file', FILE, '--line', '13', '--json'], {
    stdin: 'text', fetchRoutes: routes({ content: `${SOURCE}\n` }),
  });
  assert.equal(JSON.parse(terminated.out).code, 'LINE_NOT_IN_FILE');
  const twelfth = await run(['comment', '200101', '--file', FILE, '--line', '12', '--json'], {
    stdin: 'text', fetchRoutes: routes({ content: `${SOURCE}\n` }),
  });
  assert.equal(twelfth.code, EXIT.ok, twelfth.out);
});

test('reply lands on the thread\'s file, line and patch set, and keeps the thread\'s state unless --resolve', async () => {
  // stk0002 is on patch set 1 of 200103, whose current patch set is 2, and the
  // thread's latest comment, stk0003, is unresolved.
  const kept = await run(['reply', '200103', 'stk0002', '--json'], { stdin: 'Fixed in patch set 2.\n' });
  assert.equal(kept.code, EXIT.ok, kept.out);
  assert.equal(kept.err, '');
  assert.deepEqual(kept.fetchImpl.calls.map(requestLine), [
    'GET /a/changes/200103?o=ALL_REVISIONS',
    'GET /a/changes/200103/comments',
  ]);
  const ssh = kept.runner.calls.filter((call) => call.file === 'ssh');
  assert.equal(ssh.length, 1);
  assert.deepEqual(ssh[0].args.slice(ssh[0].args.indexOf('gerrit')), ['gerrit', 'review', '--json', '200103,1'],
    'the thread\'s patch set, not the current one');
  assert.deepEqual(JSON.parse(/** @type {string} */ (ssh[0].input)), {
    comments: { [THREAD_FILE]: [{ line: 18, message: 'Fixed in patch set 2.', unresolved: true, in_reply_to: 'stk0002' }] },
  });
  assert.deepEqual(JSON.parse(kept.out), {
    ok: true,
    op: 'reply',
    change: 200103,
    patch_set: 1,
    revision: 'c'.repeat(40),
    project: 'acme/apps/widget-console',
    branch: 'main',
    subject: 'Wire the retry ceiling to the managed configuration',
    file: THREAD_FILE,
    line: 18,
    in_reply_to: 'stk0002',
    unresolved: true,
    chars: 21,
    help: ['Run `gerrit-axi comments 200103` for the thread, this reply included'],
  });

  // --resolve closes the thread, answering whichever comment in it was named.
  const resolved = await run(['reply', '200103', 'stk0003', '--resolve', '--json'], { stdin: 'Fixed.' });
  assert.equal(resolved.code, EXIT.ok, resolved.out);
  const post = resolved.runner.calls.find((call) => call.file === 'ssh');
  assert.deepEqual(JSON.parse(/** @type {string} */ (post?.input)), {
    comments: { [THREAD_FILE]: [{ line: 18, message: 'Fixed.', unresolved: false, in_reply_to: 'stk0003' }] },
  });
  assert.equal(JSON.parse(resolved.out).unresolved, false);

  // A reply to the change-level comment has no line, and that thread was already resolved.
  const level = await run(['reply', '200103', 'stk0001', '--json'], { stdin: 'Noted.' });
  assert.equal(level.code, EXIT.ok, level.out);
  assert.deepEqual(JSON.parse(/** @type {string} */ (level.runner.calls.find((call) => call.file === 'ssh')?.input)), {
    comments: { '/PATCHSET_LEVEL': [{ message: 'Noted.', unresolved: false, in_reply_to: 'stk0001' }] },
  });
  assert.equal(JSON.parse(level.out).line, null);
  assert.equal(JSON.parse(level.out).file, '/PATCHSET_LEVEL');
  assert.equal(JSON.parse(level.out).unresolved, false);

  // A thread a later reply resolved stays resolved when its root is answered,
  // and a thread on the parent side of the diff is answered on that side.
  const thread = `)]}'\n${JSON.stringify({
    'src/Main.java': [
      {
        patch_set: 2, id: 'root0001', line: 7, side: 'PARENT', updated: '2026-08-03 07:41:02.000000000',
        message: 'Why drop this?', author: { _account_id: 4202, username: 'alan' }, unresolved: true,
      },
      {
        patch_set: 2, id: 'ans00001', line: 7, side: 'PARENT', in_reply_to: 'root0001',
        updated: '2026-08-03 09:02:55.000000000', message: 'Dead since the daemon split.',
        author: { _account_id: 1001, username: 'ada' }, unresolved: false,
      },
    ],
  })}`;
  const again = await run(['reply', '200103', 'root0001', '--json'], {
    stdin: 'Agreed.', fetchRoutes: routes({ comments: thread }),
  });
  assert.equal(again.code, EXIT.ok, again.out);
  const againPost = again.runner.calls.find((call) => call.file === 'ssh');
  assert.deepEqual(againPost?.args.slice(-1), ['200103,2']);
  assert.deepEqual(JSON.parse(/** @type {string} */ (againPost?.input)), {
    comments: { 'src/Main.java': [{ line: 7, message: 'Agreed.', unresolved: false, in_reply_to: 'root0001', side: 'PARENT' }] },
  });
  assert.equal(JSON.parse(again.out).revision, 'd'.repeat(40));
  assert.equal(JSON.parse(again.out).patch_set, 2);
});

test('a comment id the change does not carry is NO_SUCH_COMMENT, and nothing is written', async () => {
  const { code, out, err, runner } = await run(['reply', '200103', 'stk9999', '--json'], { stdin: 'text' });
  assert.equal(code, EXIT.transport);
  assert.equal(err, '');
  const record = JSON.parse(out);
  assert.deepEqual(
    { ok: record.ok, op: record.op, code: record.code, kind: record.kind, error: record.error },
    { ok: false, op: 'reply', code: 'NO_SUCH_COMMENT', kind: 'transport', error: 'no such comment on change 200103: stk9999' },
  );
  assert.match(record.remedy, /published comments/);
  assert.deepEqual(record.help, ['Run `gerrit-axi comments 200103` for the ids of the comments the change carries']);
  assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0);

  // A change the server does not return is NOT_FOUND, before any file or comment is looked for.
  for (const argv of [['comment', '200102', '--file', FILE, '--line', '1'], ['reply', '200102', 'stk0002']]) {
    const gone = await run([...argv, '--json'], {
      stdin: 'text', fetchRoutes: [{ path: /\/changes\/200102\?/, status: 404, body: 'Not found' }],
    });
    assert.equal(gone.code, EXIT.transport, argv.join(' '));
    assert.equal(JSON.parse(gone.out).code, 'NOT_FOUND', argv.join(' '));
    assert.equal(gone.runner.calls.filter((call) => call.file === 'ssh').length, 0);
  }
});

test('the text is never taken from argv, and nothing is posted when there is none', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gerrit-axi-inline-'));
  try {
    const empty = path.join(dir, 'empty.txt');
    writeFileSync(empty, '\n  \n');
    const missing = path.join(dir, 'missing.txt');
    const target = ['--file', FILE, '--line', '1'];
    const cases = [
      { argv: ['comment'], opts: { stdin: 'text' }, error: /exactly one change/ },
      { argv: ['comment', '200101', '200102', ...target], opts: { stdin: 'text' }, error: /exactly one change/ },
      { argv: ['comment', '200101', '--line', '1'], opts: { stdin: 'text' }, error: /comment needs --file <path>/ },
      { argv: ['comment', '200101', '--file', FILE], opts: { stdin: 'text' }, error: /comment needs --line <n>/ },
      { argv: ['comment', '200101', '--file', FILE, '--line', '0'], opts: { stdin: 'text' }, error: /--line must be 1 or more/ },
      { argv: ['comment', '200101', '--file', FILE, '--line', 'ten'], opts: { stdin: 'text' }, error: /--line needs a whole number/ },
      { argv: ['comment', '200101', ...target, 'Looks fine'], opts: { stdin: 'text' }, error: /not a change number: Looks fine/ },
      { argv: ['comment', '200101', ...target, '--message', 'x'], opts: { stdin: 'text' }, error: /unknown option for comment: --message/ },
      { argv: ['comment', '200101', ...target, '--resolve'], opts: { stdin: 'text' }, error: /unknown option for comment: --resolve/ },
      { argv: ['comment', '200101', ...target], opts: { stdin: '' }, error: /the comment on stdin is empty/ },
      { argv: ['comment', '200101', ...target], opts: { stdin: '  \n\n' }, error: /the comment on stdin is empty/ },
      { argv: ['comment', '200101', ...target], opts: { tty: true }, error: /comment needs its text on stdin or in --body <path>/ },
      { argv: ['comment', '200101', ...target, '--body', empty], opts: {}, error: /the comment file is empty/ },
      { argv: ['comment', '200101', ...target, '--body', missing], opts: {}, error: /no such file/ },
      { argv: ['reply'], opts: { stdin: 'text' }, error: /one change number and one comment id/ },
      { argv: ['reply', '200103'], opts: { stdin: 'text' }, error: /one change number and one comment id/ },
      { argv: ['reply', '200103', 'stk0002', 'Fixed'], opts: { stdin: 'text' }, error: /one change number and one comment id/ },
      { argv: ['reply', 'stk0002', '200103'], opts: { stdin: 'text' }, error: /not a change number: stk0002/ },
      { argv: ['reply', '200103', 'stk0002', '--file', 'x'], opts: { stdin: 'text' }, error: /unknown option for reply: --file/ },
      { argv: ['reply', '200103', 'stk0002', '--line', '1'], opts: { stdin: 'text' }, error: /unknown option for reply: --line/ },
      { argv: ['reply', '200103', 'stk0002'], opts: { stdin: '  \n' }, error: /the reply on stdin is empty/ },
      { argv: ['reply', '200103', 'stk0002'], opts: { tty: true }, error: /reply needs its text on stdin or in --body <path>/ },
      { argv: ['reply', '200103', 'stk0002', '--body', empty], opts: {}, error: /the reply file is empty/ },
    ];
    for (const { argv, opts, error } of cases) {
      const label = argv.join(' ');
      const { code, out, err, runner, fetchImpl } = await run(argv, opts);
      assert.equal(code, EXIT.usage, `${label}:\n${out}`);
      assert.equal(err, '', 'stderr stays empty on a failure');
      assert.match(out, /^code: BAD_USAGE$/m, label);
      assert.match(out, /^kind: usage$/m, label);
      assert.match(out, error, label);
      assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0, `${label} must reach no server`);
      assert.equal(fetchImpl.calls.length, 0, `${label} must reach no server`);
    }

    // The corrected call, as the usage record's help.
    const shape = await run(['comment', '200101', '--json'], { stdin: 'text' });
    assert.deepEqual(JSON.parse(shape.out).help, [
      'Run `gerrit-axi comment <change> --file <path> --line <n>` with the text on stdin, or add --body <path> to read it from a file',
    ]);
    const replyShape = await run(['reply', '200103', '--json'], { stdin: 'text' });
    assert.deepEqual(JSON.parse(replyShape.out).help, [
      'Run `gerrit-axi reply <change> <comment-id> [--resolve]` with the text on stdin, or add --body <path> to read it from a file',
    ]);

    // --body reads the file, and the text is still never in argv.
    const file = path.join(dir, 'note.md');
    writeFileSync(file, '# Finding\n\nBound too early.\n');
    const fromFile = await run(['comment', '200101', ...target, '--body', file, '--json']);
    assert.equal(fromFile.code, EXIT.ok, fromFile.out);
    const post = fromFile.runner.calls.find((call) => call.file === 'ssh');
    assert.equal(JSON.parse(/** @type {string} */ (post?.input)).comments[FILE][0].message, '# Finding\n\nBound too early.');
    assert.equal(JSON.parse(fromFile.out).chars, 27);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refusal by Gerrit is COMMENT_REFUSED in the server\'s words, and ssh failing to connect is SSH_FAILED', async () => {
  const refusal = 'error: file src/main/java/com/acme/widget/QueueReader.java not found in revision 200101,4\n'
    + 'fatal: one or more reviews failed; review output above';
  const refused = await run(['comment', '200101', '--file', FILE, '--line', '1', '--json'], {
    stdin: 'text', post: { code: 1, stderr: refusal },
  });
  assert.equal(refused.code, EXIT.transport);
  assert.equal(refused.err, '');
  const record = JSON.parse(refused.out);
  assert.deepEqual(
    { ok: record.ok, op: record.op, code: record.code, kind: record.kind },
    { ok: false, op: 'comment', code: 'COMMENT_REFUSED', kind: 'transport' },
  );
  assert.equal(record.error, `Gerrit refused the comment on change 200101: ${refusal}`);
  assert.deepEqual(record.help, ['Run `gerrit-axi show 200101` for where the change stands']);

  const down = await run(['reply', '200103', 'stk0002', '--json'], {
    stdin: 'text', post: { code: 255, stderr: 'ssh: connect to host gerrit.example.com port 29418: Connection refused' },
  });
  assert.equal(down.code, EXIT.transport);
  assert.equal(JSON.parse(down.out).code, 'SSH_FAILED');
  assert.match(JSON.parse(down.out).remedy, /gerrit version/);
});

test('a thread\'s state is its latest comment\'s, found from any comment in it', () => {
  const comments = normalizeComments({
    'src/Main.java': [
      { id: 'r', line: 7, patch_set: 1, updated: '2026-08-03 07:00:00.000000000', unresolved: true },
      { id: 'a', line: 7, patch_set: 1, in_reply_to: 'r', updated: '2026-08-03 08:00:00.000000000', unresolved: true },
      { id: 'b', line: 7, patch_set: 1, in_reply_to: 'a', updated: '2026-08-03 09:00:00.000000000', unresolved: false },
      { id: 'other', line: 9, patch_set: 1, updated: '2026-08-03 10:00:00.000000000', unresolved: true },
    ],
  });
  const byId = Object.fromEntries(comments.map((c) => [c.id, c]));
  for (const id of ['r', 'a', 'b']) {
    assert.equal(threadUnresolved(comments, byId[id]), false, `${id}: its thread's latest comment resolved it`);
  }
  assert.equal(threadUnresolved(comments, byId.other), true, 'another thread on the file is not consulted');

  // A reply whose parent the server no longer lists is the root of what remains.
  const orphan = normalizeComments({
    f: [{ id: 'o', in_reply_to: 'gone', patch_set: 1, updated: '2026-08-03 07:00:00.000000000', unresolved: true }],
  });
  assert.equal(threadUnresolved(orphan, orphan[0]), true);
});

test('lines are counted as Gerrit numbers them', () => {
  assert.equal(lineCount(Buffer.from('')), 0);
  assert.equal(lineCount(Buffer.from('one')), 1);
  assert.equal(lineCount(Buffer.from('one\n')), 1);
  assert.equal(lineCount(Buffer.from('one\ntwo')), 2);
  assert.equal(lineCount(Buffer.from('one\ntwo\n')), 2);
  assert.equal(lineCount(Buffer.from('\n\n')), 2);
  assert.equal(lineCount(Buffer.from('é\r\nü')), 2, 'bytes, not characters, and CRLF is one line end');
  assert.equal(lineCount(Buffer.from(SOURCE)), 12);
});

test('the library calls report what they posted and where', async () => {
  const runner = fakeRunner([{ match: (f, a) => f === 'ssh' && a.includes('review'), result: {} }]);
  const session = new Session({
    config: /** @type {any} */ ({ ...CONN, project: 'acme/apps/widget-console', restBase: 'https://gerrit.example.com' }),
    env: ENV,
    runner,
    fetchImpl: fakeFetch(routes()),
  });
  session.rememberToken('placeholder-not-a-real-token');

  const posted = await postInlineComment(session, '200101', { file: FILE, line: 2, text: 'Posted from the library.\n' });
  assert.deepEqual(posted, {
    change: 200101,
    patchSet: 4,
    revision: 'a'.repeat(40),
    project: 'acme/apps/widget-console',
    branch: 'main',
    subject: 'Split the queue reader out of the daemon',
    file: FILE,
    line: 2,
    inReplyTo: null,
    unresolved: true,
    chars: 24,
  });
  const replied = await replyToComment(session, 200103, 'stk0002', { text: 'And here.', resolve: true });
  assert.deepEqual(
    [replied.patchSet, replied.revision, replied.file, replied.line, replied.inReplyTo, replied.unresolved, replied.chars],
    [1, 'c'.repeat(40), THREAD_FILE, 18, 'stk0002', false, 9],
  );

  await assert.rejects(postInlineComment(session, 200101, { file: FILE, line: 2, text: '  ' }),
    /** @type {any} */ ((err) => err.code === 'EMPTY_MESSAGE'));
  await assert.rejects(postInlineComment(session, 'HEAD', { file: FILE, line: 2, text: 'x' }),
    /** @type {any} */ ((err) => err.code === 'BAD_RESPONSE'));
  await assert.rejects(replyToComment(session, 200103, '', { text: 'x' }),
    /** @type {any} */ ((err) => err.code === 'BAD_RESPONSE'));
  await assert.rejects(replyToComment(session, 200103, 'stk0002', { text: 'x', resolve: /** @type {any} */ ('yes') }),
    /** @type {any} */ ((err) => err.code === 'BAD_RESPONSE'));
  assert.equal(runner.calls.filter((call) => call.args.includes('review')).length, 2,
    'the refused calls made no round trip');
});
