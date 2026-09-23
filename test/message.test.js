// SPDX-License-Identifier: Apache-2.0

/**
 * The third write: one change-level message on one change.
 *
 * Offline like everything else here. The change is looked up from the recorded
 * three-change stack, and the post is answered by a fake ssh, so both round
 * trips run the real code with no server anywhere. The one thing a fixture
 * cannot record is how Gerrit's sshd splits the remote command line, so
 * `gerritSplit` below models its tokeniser -- space and tab separate, single and
 * double quotes group, backslash escapes outside single quotes -- and the tests
 * assert the text arrives as one word through it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { EXIT, main } from '../src/axi/main.js';
import { buildMessageArgs, postChangeMessage, quoteForGerrit } from '../src/core/message.js';
import { Session } from '../src/core/session.js';
import { captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const CONN = { host: 'gerrit.example.com', port: 29418, user: 'ada' };

/**
 * Gerrit's own splitting of an ssh remote command line, as its sshd does it
 * before any command sees an argument. A shell-like tokeniser: whitespace
 * separates, quotes of either kind group, and outside single quotes a backslash
 * makes the next character literal.
 *
 * @param {string} line
 * @returns {string[]}
 */
function gerritSplit(line) {
  /** @type {string[]} */
  const words = [];
  let word = '';
  let started = false;
  let single = false;
  let double = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if ((c === ' ' || c === '\t') && !single && !double) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (c === '"' && !single) { double = !double; started = true; continue; }
    if (c === "'" && !double) { single = !single; started = true; continue; }
    if (c === '\\' && !single && i + 1 < line.length) {
      word += line[i + 1];
      i += 1;
      started = true;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

/**
 * Drive the binary with a message on stdin or in a file. `ssh` answers the query
 * from a fixture and the post with `post`, so a test can make Gerrit refuse.
 *
 * @param {string[]} argv
 * @param {{stdin?: string|null, tty?: boolean, query?: string,
 *          post?: {code?: number, stdout?: string, stderr?: string}}} [opts]
 */
async function run(argv, { stdin = null, tty = false, query = 'query-stack.txt', post = {} } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    { match: (f, a) => f === 'ssh' && a.includes('review'), result: post },
    { match: (f, a) => f === 'ssh' && a.includes('query'), result: { stdout: fixture(query) } },
  ]);
  /** @type {any} */
  const input = stdin === null ? { isTTY: tty } : Object.assign(Readable.from([stdin]), { isTTY: tty });
  const code = await main(argv, {
    cwd: '/some/checkout',
    env: ENV,
    stdin: input,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner,
    fetchImpl: fakeFetch([]),
  });
  return { code, out: stdout.text, err: stderr.text, runner };
}

test('the text becomes one word of the remote command line, whatever it contains', () => {
  const texts = [
    'Looks fine.',
    "Review corrected the KDoc: it isn't 0.0, it's Double.NaN.",
    'two\nlines\twith a tab, "double quotes", `backticks`, $(id) and ; a semicolon',
    "'",
    "''",
    'a backslash \\ and an escaped \\\' quote',
    '--code-review +2 --label Verified=+1 --submit',
    '-1 leading dash',
  ];
  for (const text of texts) {
    const words = gerritSplit(`gerrit review --message ${quoteForGerrit(text)} 200101,4`);
    assert.deepEqual(words, ['gerrit', 'review', '--message', text, '200101,4'],
      `Gerrit must read ${JSON.stringify(text)} back as one word`);
  }
});

test('the argv is pinned: destination, gerrit review, --message, the quoted text, change,patchset', () => {
  const text = 'What the pipeline changed:\n\n- the KDoc default is Double.NaN, not 0.0\n';
  assert.deepEqual(buildMessageArgs(CONN, 200101, 4, text), [
    '-p', '29418',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '--',
    'ada@gerrit.example.com',
    'gerrit', 'review',
    '--message', "'What the pipeline changed:\n\n- the KDoc default is Double.NaN, not 0.0'",
    '200101,4',
  ]);
});

test('an empty text, or one no argv can carry, is refused before anything runs', () => {
  for (const text of ['', '   ', '\n\n', undefined, null]) {
    assert.throws(() => buildMessageArgs(CONN, 200101, 4, /** @type {any} */ (text)),
      /** @type {any} */ ((err) => err.code === 'EMPTY_MESSAGE'));
  }
  assert.throws(() => buildMessageArgs(CONN, 200101, 4, 'has a \0 in it'),
    /** @type {any} */ ((err) => err.code === 'UNSAFE_MESSAGE'));
  assert.throws(() => buildMessageArgs(CONN, 0, 4, 'text'), /not a change number/);
  assert.throws(() => buildMessageArgs(CONN, 200101, 0, 'text'), /not a patch set number/);
  assert.throws(() => buildMessageArgs({ ...CONN, user: '-oProxyCommand=id' }, 200101, 4, 'text'),
    /** @type {any} */ ((err) => err.code === 'UNSAFE_CONNECTION'));
});

test('message reads stdin, posts on the current patch set, and names it in the record', async () => {
  const text = 'What the pipeline changed:\n\n- the KDoc default is Double.NaN, not 0.0\n\n';
  const { code, out, err, runner } = await run(['message', '200101'], { stdin: text });
  assert.equal(code, EXIT.ok, err);

  const ssh = runner.calls.filter((call) => call.file === 'ssh');
  assert.equal(ssh.length, 2, 'one query for the patch set, then one post');
  assert.ok(ssh[0].args.includes('query') && ssh[0].args.includes('change:200101'),
    'the change is looked up first so the post names the patch set the server has');
  assert.ok(ssh[0].args.includes('--submit-records'), 'the query is the same one every command sends');
  const at = ssh[1].args.indexOf('gerrit');
  assert.deepEqual(ssh[1].args.slice(at), [
    'gerrit', 'review',
    '--message', "'What the pipeline changed:\n\n- the KDoc default is Double.NaN, not 0.0'",
    '200101,4',
  ], 'trailing whitespace is dropped and the text is one quoted word');
  // The text is never an element of this process's own argv, and no runner
  // received it on stdin either: it travels only as a word of the remote line.
  for (const call of runner.calls) assert.equal(call.input, undefined);

  assert.match(out, /^ok: true$/m);
  assert.match(out, /^op: message$/m);
  assert.match(out, /^change: 200101$/m);
  assert.match(out, /^patch_set: 4$/m);
  assert.match(out, /^revision: [0-9a-f]{40}$/m);
  assert.match(out, /^project: acme\/apps\/widget-console$/m);
  assert.match(out, /^subject: Split the queue reader out of the daemon$/m);
  assert.match(out, /^chars: 69$/m);
  assert.equal(err, '');
});

test('--file reads the text from a file, and --json carries the same fields typed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gerrit-axi-message-'));
  try {
    const file = path.join(dir, 'message.md');
    writeFileSync(file, '# Pipeline findings\n\nOne KDoc corrected.\n');
    const { code, out, err, runner } = await run(['message', '200102', '--file', file, '--json']);
    assert.equal(code, EXIT.ok, err);
    const post = runner.calls.find((call) => call.file === 'ssh' && call.args.includes('review'));
    assert.ok(post);
    assert.equal(post.args.at(-2), "'# Pipeline findings\n\nOne KDoc corrected.'");
    assert.equal(post.args.at(-1), '200102,2');
    const record = JSON.parse(out);
    assert.equal(record.ok, true);
    assert.equal(record.op, 'message');
    assert.equal(record.change, 200102);
    assert.equal(record.patch_set, 2, 'a number stays a number');
    assert.equal(record.chars, 40);
    assert.equal(typeof record.url, 'string');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the text is never taken from argv, and nothing is posted when there is none', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gerrit-axi-message-'));
  try {
    const empty = path.join(dir, 'empty.txt');
    writeFileSync(empty, '\n  \n');
    const cases = [
      { argv: ['message'], opts: { stdin: 'text' }, error: /exactly one change/ },
      { argv: ['message', '200101', '200102'], opts: { stdin: 'text' }, error: /exactly one change/ },
      { argv: ['message', '200101', 'Looks fine'], opts: { stdin: 'text' }, error: /not a change number/ },
      { argv: ['message', '200101', '--message', 'x'], opts: { stdin: 'text' }, error: /unknown option: --message/ },
      { argv: ['message', '200101'], opts: { stdin: '' }, error: /stdin is empty/ },
      { argv: ['message', '200101'], opts: { stdin: '  \n\n' }, error: /stdin is empty/ },
      { argv: ['message', '200101'], opts: { tty: true }, error: /stdin or in --file/ },
      { argv: ['message', '200101', '--file', empty], opts: {}, error: /file is empty/ },
      { argv: ['message', '200101', '--file', path.join(dir, 'missing.txt')], opts: {}, error: /no such file/ },
    ];
    for (const { argv, opts, error } of cases) {
      const { code, out, err, runner } = await run(argv, opts);
      assert.equal(code, EXIT.usage, `${argv.join(' ')}:\n${err}`);
      assert.equal(out, '', 'stdout stays empty on a failure');
      assert.match(err, /^code: BAD_USAGE$/m);
      assert.match(err, /^kind: usage$/m);
      assert.match(err, error, argv.join(' '));
      assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0,
        `${argv.join(' ')} must reach no server`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a change the server does not return is NOT_FOUND, and nothing is posted', async () => {
  const { code, out, err, runner } = await run(['message', '999999', '--json'], {
    stdin: 'text', query: 'query-empty.txt',
  });
  assert.equal(code, EXIT.transport);
  assert.equal(out, '');
  const record = JSON.parse(err);
  assert.deepEqual(
    { ok: record.ok, op: record.op, code: record.code, kind: record.kind },
    { ok: false, op: 'message', code: 'NOT_FOUND', kind: 'transport' },
  );
  assert.equal(runner.calls.filter((call) => call.file === 'ssh' && call.args.includes('review')).length, 0);
});

test('a refusal by Gerrit is an error record carrying the server\'s own words', async () => {
  const refusal = 'error: change 200103 is closed to new messages\nfatal: one or more reviews failed; review output above';
  const { code, out, err } = await run(['message', '200103', '--json'], {
    stdin: 'text', post: { code: 1, stderr: refusal },
  });
  assert.equal(code, EXIT.transport);
  assert.equal(out, '');
  const record = JSON.parse(err);
  assert.deepEqual(
    { ok: record.ok, op: record.op, code: record.code, kind: record.kind },
    { ok: false, op: 'message', code: 'MESSAGE_REFUSED', kind: 'transport' },
  );
  assert.equal(record.error, `Gerrit refused the message on change 200103: ${refusal}`);
});

test('ssh failing to connect on the post is SSH_FAILED with the usual remedy', async () => {
  const { code, err } = await run(['message', '200101', '--json'], {
    stdin: 'text', post: { code: 255, stderr: 'ssh: connect to host gerrit.example.com port 29418: Connection refused' },
  });
  assert.equal(code, EXIT.transport);
  const record = JSON.parse(err);
  assert.equal(record.code, 'SSH_FAILED');
  assert.match(record.remedy, /gerrit version/);
});

test('the library call reports what it posted and where', async () => {
  const runner = fakeRunner([
    { match: (f, a) => f === 'ssh' && a.includes('review'), result: {} },
    { match: (f, a) => f === 'ssh' && a.includes('query'), result: { stdout: fixture('query-stack.txt') } },
  ]);
  const session = new Session({
    config: /** @type {any} */ ({ ...CONN, project: 'acme/apps/widget-console', restBase: 'https://gerrit.example.com' }),
    env: ENV,
    runner,
    fetchImpl: fakeFetch([]),
  });
  const posted = await postChangeMessage(session, '200103', 'Posted from the library.\n');
  assert.deepEqual(
    { change: posted.change, patchSet: posted.patchSet, project: posted.project, chars: posted.chars },
    { change: 200103, patchSet: 1, project: 'acme/apps/widget-console', chars: 24 },
  );
  await assert.rejects(postChangeMessage(session, 200103, '  '),
    /** @type {any} */ ((err) => err.code === 'EMPTY_MESSAGE'));
  assert.equal(runner.calls.filter((call) => call.args.includes('review')).length, 1,
    'the empty text was refused before any round trip');
});
