// SPDX-License-Identifier: Apache-2.0

/**
 * The agent tier: one invocation, a list of changes, typed records out.
 *
 * Offline like everything else here. `test/fixtures/query-stack.txt` is a
 * recorded three-change `gerrit query` response, and the comment bodies are
 * recorded REST responses, so the real code path runs with no server anywhere.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EXIT, main } from '../src/axi/main.js';
import { Session } from '../src/core/session.js';
import { encode } from '../src/axi/toon.js';
import { errorRecord } from '../src/axi/output.js';
import { SRC_DIR, captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';
const REPO_ROOT = path.join(SRC_DIR, '..');

/**
 * A server's answers to the dashboard's four queries, keyed by the prefix that
 * tells them apart: ada has one change awaiting her, owns the three-change stack
 * (one of them WIP), was asked to review two others, and is CCed on nothing.
 */
const DASHBOARD = {
  'attention:self': 'query-detail.txt',
  'owner:self': 'query-stack.txt',
  'reviewer:self': 'query-incoming.txt',
  'cc:self': 'query-empty.txt',
};

/**
 * Drive the binary's entry point the way a caller would, with every process edge
 * supplied: no network, no subprocess, no credential store. `ssh` is one fixture
 * for every query, or a table of fixtures keyed by the prefix of the query each
 * one answers.
 *
 * @param {string[]} argv
 * @param {{ssh?: string|Record<string, string>, fetchRoutes?: any[]}} [opts]
 */
async function run(argv, { ssh = 'query-stack.txt', fetchRoutes = [] } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const answer = typeof ssh === 'string'
    ? () => ({ stdout: fixture(ssh) })
    : (/** @type {string} */ _file, /** @type {string[]} */ args) => {
      const query = args.at(-2) ?? ''; // the last element is the limit
      const prefix = Object.keys(ssh).find((p) => query.startsWith(p));
      assert.ok(prefix, `no fixture answers the query: ${query}`);
      return { stdout: fixture(ssh[prefix]) };
    };
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    { match: (f) => f === 'ssh', result: answer },
  ]);
  const code = await main(argv, {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner,
    fetchImpl: fakeFetch(fetchRoutes),
  });
  return { code, out: stdout.text, err: stderr.text, runner };
}

/**
 * Read one TOON table back into rows keyed by field name -- which is the whole
 * claim this tier makes, so the tests read it the way a consumer would rather
 * than by matching on a line's shape.
 *
 * @param {string} toon
 * @param {string} name
 * @returns {Array<Record<string, string>>}
 */
function table(toon, name) {
  const lines = toon.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${name}[`));
  assert.notEqual(start, -1, `no ${name} table in:\n${toon}`);
  const header = /^[a-z_]+\[(\d+)\]\{(.+)\}:$/.exec(lines[start]);
  assert.ok(header, `${name} is not a tabular header: ${lines[start]}`);
  const fields = header[2].split(',');
  const rows = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith('  '); i += 1) {
    rows.push(Object.fromEntries(splitRow(lines[i].slice(2)).map((v, j) => [fields[j], v])));
  }
  assert.equal(rows.length, Number(header[1]), `${name} declared ${header[1]} rows`);
  return rows;
}

/** The escape sequences the encoder emits inside a quoted field. */
const UNESCAPE = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Split a row on its unquoted delimiters. `raw` keeps each field exactly as
 * written -- quotes and escapes intact -- which is what decodeFlat needs to
 * judge a token; otherwise fields come back decoded, as a consumer wants them.
 *
 * @param {string} line
 * @param {{raw?: boolean}} [opts]
 * @returns {string[]}
 */
function splitRow(line, { raw = false } = {}) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted && c === '\\') {
      const next = line[i + 1];
      field += raw ? c + next : (Object.hasOwn(UNESCAPE, next) ? UNESCAPE[next] : next);
      i += 1;
      continue;
    }
    if (c === '"') { quoted = !quoted; if (raw) field += c; continue; }
    if (c === ',' && !quoted) { out.push(field); field = ''; continue; }
    field += c;
  }
  out.push(field);
  return out;
}

test('one invocation answers about a whole list of changes', async () => {
  const { code, out, runner } = await run(['show', '200101', '200102', '200103']);
  assert.equal(code, EXIT.ok);

  // One ssh call, not three: a stack watch must not pay per change.
  assert.equal(runner.calls.filter((c) => c.file === 'ssh').length, 1);
  const { args } = runner.calls.find((c) => c.file === 'ssh') ?? { args: [] };
  assert.ok(args.some((a) => a.includes('change:200101 OR change:200102 OR change:200103')));

  const changes = table(out, 'changes');
  // Returned in the order they were asked for, so a caller can zip its own list.
  assert.deepEqual(changes.map((c) => c.change), ['200101', '200102', '200103']);
  assert.deepEqual(changes.map((c) => c.submit), ['OK', 'NOT_READY', 'NOT_READY']);
  assert.deepEqual(changes.map((c) => c.submittable), ['true', 'false', 'false']);
  assert.deepEqual(changes.map((c) => c.blocked_on),
    ['', 'Xylophone-Gate,Zebu-Herding', 'Quokka-Review']);
  assert.deepEqual(changes.map((c) => c.wip), ['false', 'false', 'true']);
  assert.deepEqual(changes.map((c) => c.patch_set), ['4', '2', '1']);
  assert.equal(changes[0].revision, 'a'.repeat(40));
  assert.equal(changes[2].ref, 'refs/changes/03/200103/1');
  assert.equal(changes[1].owner, 'ada');
  assert.equal(changes[1].project, 'acme/apps/widget-console');
  assert.equal(changes[1].branch, 'main');
  assert.equal(changes[1].subject, 'Give the queue reader its own retry ceiling');
  assert.equal(changes[1].updated, new Date(1785636000 * 1000).toISOString());
});

test('a label the server has grown adds a row and moves no column', async () => {
  // 200102 carries a label the other two do not. Read by name it is simply an
  // extra row; the changes table's own header must be identical to a run whose
  // result set has no such label, which is the property the screen-scraping
  // shell scripts this tier replaces could not have.
  const stack = await run(['show', '200101', '200102', '200103']);
  const single = await run(['show', '184458'], { ssh: 'query-detail.txt' });

  const headerOf = (/** @type {string} */ text, /** @type {string} */ name) => (
    text.split('\n').find((line) => line.startsWith(`${name}[`))?.replace(/\[\d+\]/, '[n]')
  );
  assert.equal(headerOf(stack.out, 'changes'), headerOf(single.out, 'changes'));
  assert.equal(headerOf(stack.out, 'labels'), headerOf(single.out, 'labels'));

  const labels = table(stack.out, 'labels');
  const forChange = (/** @type {string} */ n) => labels.filter((l) => l.change === n);
  assert.deepEqual(forChange('200101').map((l) => l.label), ['Quokka-Review', 'Xylophone-Gate']);
  assert.deepEqual(forChange('200102').map((l) => l.label),
    ['Quokka-Review', 'Xylophone-Gate', 'Zebu-Herding']);

  const grown = labels.find((l) => l.change === '200102' && l.label === 'Zebu-Herding');
  assert.equal(grown?.status, 'NEED');
  assert.equal(grown?.blocking, 'true');
  assert.equal(grown?.by, 'null', 'nobody has satisfied it');

  // A label nobody voted on is still reported, and the server's own verdict is
  // credited to the account the server named.
  const rejected = labels.find((l) => l.change === '200103' && l.label === 'Quokka-Review');
  assert.equal(rejected?.status, 'REJECT');
  assert.equal(rejected?.by, 'alan');
});

test('every vote carries its label, its value, who cast it and when', async () => {
  const { out } = await run(['show', '200103']);
  const votes = table(out, 'votes').filter((v) => v.change === '200103');
  assert.deepEqual(votes.map((v) => [v.label, v.value, v.by]), [
    ['Quokka-Review', '1', 'grace'],
    ['Quokka-Review', '-2', 'alan'],
    ['Xylophone-Gate', '1', 'buildbot'],
  ]);
  assert.equal(votes[1].granted, new Date(1785726000 * 1000).toISOString());
});

test('the stack comes back with the staleness flag a stack watch exists to notice', async () => {
  const { out } = await run(['show', '200101', '200102', '200103']);

  const depends = table(out, 'depends_on');
  assert.deepEqual(depends.map((d) => [d.change, d.related, d.current]), [
    ['200102', '200101', 'true'],
    ['200103', '200102', 'false'],
  ]);
  const needed = table(out, 'needed_by');
  assert.deepEqual(needed.map((d) => [d.change, d.related]), [
    ['200101', '200102'],
    ['200102', '200103'],
  ]);
});

test('a change number the server did not return is reported missing, not as a failure', async () => {
  const { code, out } = await run(['show', '200101', '999999', '200103']);
  assert.equal(code, EXIT.ok, 'a change that is gone is data, not a broken call');
  assert.match(out, /^missing\[1\]: 999999$/m);
  assert.deepEqual(table(out, 'changes').map((c) => c.change), ['200101', '200103']);
});

test('cover messages are opt-in, and the query only asks for what will be emitted', async () => {
  const bare = await run(['show', '200102']);
  assert.equal(bare.out.includes('messages['), false, 'no messages table by default');
  const bareArgs = bare.runner.calls.find((c) => c.file === 'ssh')?.args ?? [];
  assert.equal(bareArgs.includes('--comments'), false, 'nor is the server asked for them');
  assert.ok(bareArgs.includes('--dependencies'), 'the stack is always asked for');
  assert.ok(bareArgs.includes('--submit-records'), 'readiness is never optional');

  const asked = await run(['show', '200102', '--messages', 'all']);
  assert.ok((asked.runner.calls.find((c) => c.file === 'ssh')?.args ?? []).includes('--comments'));
  const messages = table(asked.out, 'messages');
  assert.deepEqual(messages.map((m) => m.patch_set), ['1', '1', '2'], 'oldest first');
  assert.equal(messages[1].author, 'buildbot');
  assert.equal(messages[1].urls, 'https://ci.example.com/job/queue-reader/91/');
  assert.match(messages[1].message, /Build Failed/);
  assert.match(messages[1].message, /^Patch Set 1: Xylophone-Gate-1\n/, 'the body is verbatim');

  const bounded = await run(['show', '200102', '--messages', '1']);
  const kept = table(bounded.out, 'messages');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].author, 'grace', 'the newest is the one kept');
});

test('inline comments come back typed, per change, with the bot split explicit', async () => {
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({
    token: 'placeholder-not-a-real-token',
    backend: 'file',
    location: null,
  });
  try {
    const routes = [
      // 200102 has none; 200103 has the recorded thread.
      { path: /\/changes\/200102\/comments$/, body: `)]}'\n{}` },
      { path: /\/changes\/200103\/comments$/, body: fixture('comments-stack.txt') },
    ];
    const { code, out } = await run(['comments', '200102', '200103'], { fetchRoutes: routes });
    assert.equal(code, EXIT.ok);

    const comments = table(out, 'comments');
    assert.deepEqual([...new Set(comments.map((c) => c.change))], ['200103'],
      'a change with no comments contributes no rows, and attribution is per change');
    assert.deepEqual(comments.map((c) => [c.file, c.line, c.bot, c.bot_kind]), [
      ['/PATCHSET_LEVEL', 'null', 'true', 'ai-review'],
      ['src/main/java/com/acme/widget/RetryCeiling.java', '18', 'true', 'ai-review'],
      ['src/main/java/com/acme/widget/RetryCeiling.java', '18', 'false', 'null'],
    ]);
    assert.equal(comments[2].in_reply_to, 'stk0002');
    assert.equal(comments[2].author, 'alan');
    assert.deepEqual(comments.map((c) => c.unresolved), ['false', 'true', 'true']);
    assert.equal(comments[0].severity, 'null', 'no severity patterns are configured');

    const bots = await run(['comments', '200103', '--bots'], { fetchRoutes: routes });
    assert.deepEqual(table(bots.out, 'comments').map((c) => c.author),
      ['review-assistant', 'review-assistant']);
    const humans = await run(['comments', '200103', '--humans'], { fetchRoutes: routes });
    assert.deepEqual(table(humans.out, 'comments').map((c) => c.author), ['alan']);
  } finally {
    Session.prototype.token = restored;
  }
});

test('show --comments answers the whole watch in one invocation', async () => {
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({
    token: 'placeholder-not-a-real-token',
    backend: 'file',
    location: null,
  });
  try {
    const { code, out } = await run(['show', '200102', '200103', '--comments'], {
      fetchRoutes: [
        { path: /\/changes\/200102\/comments$/, body: `)]}'\n{}` },
        { path: /\/changes\/200103\/comments$/, body: fixture('comments-stack.txt') },
      ],
    });
    assert.equal(code, EXIT.ok);
    // Readiness, labels, the stack and the inline comments, all from one call.
    assert.deepEqual(table(out, 'changes').map((c) => c.change), ['200102', '200103']);
    assert.ok(table(out, 'labels').some((l) => l.label === 'Zebu-Herding'));
    assert.ok(table(out, 'depends_on').some((d) => d.current === 'false'));
    assert.deepEqual(table(out, 'comments').map((c) => c.id),
      ['stk0001', 'stk0002', 'stk0003']);
  } finally {
    Session.prototype.token = restored;
  }
});

test('--json carries the same fields as strict JSON', async () => {
  const { code, out } = await run(['show', '200101', '200102', '--json']);
  assert.equal(code, EXIT.ok);
  const document = JSON.parse(out);
  assert.equal(document.ok, true);
  assert.equal(document.op, 'show');
  assert.equal(document.count, 2);
  assert.deepEqual(document.missing, []);
  assert.deepEqual(document.changes.map((/** @type {any} */ c) => c.change), [200101, 200102]);
  assert.equal(document.changes[1].submittable, false, 'a boolean stays a boolean');
  assert.equal(document.changes[1].blocked_on, 'Xylophone-Gate,Zebu-Herding');
  assert.equal(document.changes[0].topic, 'stack-of-three');
  assert.deepEqual(
    document.labels.filter((/** @type {any} */ l) => l.change === 200102).map((/** @type {any} */ l) => l.label),
    ['Quokka-Review', 'Xylophone-Gate', 'Zebu-Herding'],
  );
  assert.equal(document.votes[0].value, 2, 'a vote value is a number');
});

test('a failure is a typed record on stderr, never prose on stdout', async () => {
  const cases = [
    { argv: ['nope'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['show', 'HEAD'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['show'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['show', '1', '--nonsense'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['status', '--limit', 'lots'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['dashboard', '200101'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['--rows', 'lots'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['--rows', '0'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['dashboard', '--rows', '101'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['comments', '1', '--bots', '--humans'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['auth', 'login'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    // The shape is named, never guessed, and a stack needs the topic that makes it one.
    { argv: ['publish'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['publish', '--stack', '--squash', '--topic', 't'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['publish', '--stack'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['publish', '--squash', 'HEAD'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['publish', '--squash', '--topic', 't'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['submit'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['submit', '200101', '200102'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
    { argv: ['submit', 'HEAD'], code: EXIT.usage, error: 'BAD_USAGE', kind: 'usage' },
  ];
  for (const expected of cases) {
    const { code, out, err } = await run(expected.argv);
    assert.equal(code, expected.code, `${expected.argv.join(' ')} exit code`);
    assert.equal(out, '', `${expected.argv.join(' ')} must write nothing to stdout`);
    assert.match(err, /^ok: false$/m);
    assert.match(err, new RegExp(`^code: ${expected.error}$`, 'm'));
    assert.match(err, new RegExp(`^kind: ${expected.kind}$`, 'm'));
  }
});

test('the failure record distinguishes configuration, auth and transport', async () => {
  // No git remote, no env, no config file: the host cannot be resolved.
  const stdout = captureStream();
  const stderr = captureStream();
  const config = await main(['show', '1'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: fakeRunner([{ match: () => true, result: { code: 1, stdout: '' } }]),
  });
  assert.equal(config, EXIT.config);
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /^code: HOST_UNRESOLVED$/m);
  assert.match(stderr.text, /^kind: config$/m);
  assert.match(stderr.text, /^remedy: /m, 'core\'s remedy is passed through for a human reading a log');

  // A credential the server rejects, and a change nobody can see.
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({
    token: 'placeholder-not-a-real-token',
    backend: 'file',
    location: null,
  });
  try {
    const unauthorized = await run(['comments', '200103'], {
      fetchRoutes: [{ path: /comments$/, status: 401, body: 'Unauthorized' }],
    });
    assert.equal(unauthorized.code, EXIT.auth);
    assert.match(unauthorized.err, /^kind: auth$/m);
    assert.match(unauthorized.err, /^code: UNAUTHORIZED$/m);

    const notFound = await run(['comments', '200103', '--json'], {
      fetchRoutes: [{ path: /comments$/, status: 404, body: 'Not found' }],
    });
    assert.equal(notFound.code, EXIT.transport);
    assert.equal(notFound.out, '');
    const record = JSON.parse(notFound.err);
    assert.deepEqual(
      { ok: record.ok, op: record.op, code: record.code, kind: record.kind },
      { ok: false, op: 'comments', code: 'NOT_FOUND', kind: 'transport' },
    );
  } finally {
    Session.prototype.token = restored;
  }
});

test('no token can reach an error record', () => {
  // The credential invariant, restated at this layer: nothing here inspects a
  // token, so nothing here can leak one.
  const record = errorRecord(new Error('the server said no'), { op: 'comments' });
  assert.equal(JSON.stringify(record).includes('placeholder-not-a-real-token'), false);
  assert.deepEqual(Object.keys(record), ['ok', 'op', 'error', 'code', 'kind']);
});

test('status takes the same shapes the human CLI does', async () => {
  const attention = await run(['status'], { ssh: 'query-output.txt' });
  assert.equal(attention.code, EXIT.ok);
  assert.ok((attention.runner.calls.find((c) => c.file === 'ssh')?.args ?? [])
    .some((a) => a === 'attention:self status:open'));
  // Newest first, which is what "what changed" wants.
  assert.deepEqual(table(attention.out, 'changes').map((c) => c.change),
    ['184431', '184458', '184402']);

  const mine = await run(['status', 'mine'], { ssh: 'query-output.txt' });
  assert.ok((mine.runner.calls.find((c) => c.file === 'ssh')?.args ?? [])
    .some((a) => a === 'owner:self status:open'));

  const raw = await run(['status', '--query', 'project:acme/one status:open'], { ssh: 'query-output.txt' });
  assert.ok((raw.runner.calls.find((c) => c.file === 'ssh')?.args ?? [])
    .some((a) => a === 'project:acme/one status:open'));

  const limited = await run(['status', '--limit', '5'], { ssh: 'query-output.txt' });
  assert.ok((limited.runner.calls.find((c) => c.file === 'ssh')?.args ?? []).includes('limit:5'));
});

test('an empty result set keeps the shape rather than printing nothing', async () => {
  // A watch whose stack has all landed reads this on every tick. The tables have
  // to still be there, empty, or a consumer has to special-case the quiet case.
  const stats = '{"type":"stats","rowCount":0,"runTimeMilliseconds":3,"moreChanges":false}\n';
  const stdout = captureStream();
  const code = await main(['status', '--json'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: stats } },
    ]),
  });
  assert.equal(code, EXIT.ok);
  assert.deepEqual(JSON.parse(stdout.text),
    { ok: true, op: 'status', count: 0, changes: [], labels: [], votes: [] });
});

test('auth status reports the credential without a change to ask about', async () => {
  const stdout = captureStream();
  const code = await main(['auth', 'status', '--json'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    // Empty PATH, so no keyring backend is found and nothing is stored.
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    ]),
    fetchImpl: fakeFetch([]),
  });
  assert.equal(code, EXIT.ok);
  const record = JSON.parse(stdout.text);
  assert.equal(record.op, 'auth status');
  assert.equal(record.stored, false);
  assert.equal(record.verified, false);
  assert.equal(record.user, 'ada');
  assert.equal(JSON.stringify(record).includes('placeholder-not-a-real-token'), false);
});

test('help and version need no config, no credential and no network', async () => {
  for (const argv of [['--help'], ['help'], ['show', '--help']]) {
    const stdout = captureStream();
    const code = await main(argv, {
      cwd: '/nowhere',
      env: {},
      stdout: stdout.stream,
      stderr: captureStream().stream,
      runner: fakeRunner([]),
    });
    assert.equal(code, EXIT.ok, argv.join(' '));
    assert.match(stdout.text, /^gerrit-axi - /);
  }

  const stdout = captureStream();
  assert.equal(await main(['--version'], {
    cwd: '/nowhere',
    env: {},
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([]),
  }), EXIT.ok);
  assert.match(stdout.text, /^gerrit-axi \d+\.\d+\.\d+$/m);
});

test('a bare invocation is the dashboard, not usage', async () => {
  const { code, out, err, runner } = await run([], { ssh: DASHBOARD });
  assert.equal(code, EXIT.ok);
  assert.equal(err, '');
  assert.equal(out.includes('usage:'), false, 'usage is for a caller who asked for it');

  // Four round trips, one per question the server answers in a single query,
  // in the order the sections are shown. The owner query serves two sections.
  const queries = runner.calls.filter((c) => c.file === 'ssh').map((c) => c.args.at(-2));
  assert.deepEqual(queries, [
    'attention:self status:open',
    'owner:self status:open',
    'reviewer:self NOT owner:self NOT is:wip status:open',
    'cc:self NOT is:wip status:open',
  ]);
  // Over ssh the query is words of a remote command line, and Gerrit's parser
  // reads a word that begins with "-" as an option of `gerrit query`. A live
  // server refused `-owner:self` that way, so negation is spelled NOT.
  for (const query of queries) {
    assert.ok(query.split(' ').every((word) => !word.startsWith('-')),
      `a query word beginning with "-" is read by Gerrit as an option: ${query}`);
  }

  assert.match(out, /^op: dashboard$/m);
  assert.match(out, /^user: ada$/m);
  assert.match(out, /^total: 6$/m);
  const sections = table(out, 'sections');
  assert.deepEqual(sections.map((s) => [s.section, s.count, s.shown, s.more]), [
    ['your_turn', '1', '1', 'false'],
    ['wip', '1', '1', 'false'],
    ['outgoing', '2', '2', 'false'],
    ['incoming', '2', '2', 'false'],
    ['cced', '0', '0', 'false'],
  ]);
  // Each section's query reproduces it on its own, ready for `status --query`.
  assert.equal(sections[1].query, 'owner:self status:open is:wip');
  assert.equal(sections[2].query, 'owner:self status:open NOT is:wip');

  const entries = table(out, 'entries');
  assert.deepEqual(entries.map((e) => [e.section, e.change]), [
    ['your_turn', '184458'],
    ['wip', '200103'],
    ['outgoing', '200102'],
    ['outgoing', '200101'],
    ['incoming', '300202'],
    ['incoming', '300201'],
  ], 'wip and outgoing are split from one owner query; newest first within a section');
  assert.deepEqual(entries[4], {
    section: 'incoming',
    change: '300202',
    subject: 'Let the queue reader name its own thread',
    owner: 'alan',
    submit: 'OK',
  });
  assert.match(out, /^help\[1\]: Run `gerrit-axi show 184458 --comments` for the full state of what awaits you$/m);
});

test('the dashboard answers to its name and to a bare option alike', async () => {
  const bare = await run([], { ssh: DASHBOARD });
  const named = await run(['dashboard'], { ssh: DASHBOARD });
  assert.equal(named.out, bare.out);

  // An option with no command is still the dashboard, with the option applied.
  const overridden = await run(['--host', 'review.example.org'], { ssh: DASHBOARD });
  assert.equal(overridden.code, EXIT.ok);
  assert.match(overridden.out, /^host: review\.example\.org$/m);
  const ssh = overridden.runner.calls.find((c) => c.file === 'ssh');
  assert.ok(ssh?.args.includes('ada@review.example.org'));
});

test('a change on two sections appears under each, and is counted once', async () => {
  // The attention set now answers with the stack itself, so ada's own changes
  // are both her turn and her outgoing reviews, as they would be on Gerrit's
  // dashboard. `total` is distinct changes; the pair (section, change) is the key.
  const { out } = await run([], { ssh: { ...DASHBOARD, 'attention:self': 'query-stack.txt' } });
  assert.match(out, /^total: 5$/m);
  const entries = table(out, 'entries');
  assert.deepEqual(entries.filter((e) => e.change === '200102').map((e) => e.section),
    ['your_turn', 'outgoing']);
  assert.deepEqual(entries.filter((e) => e.section === 'your_turn').map((e) => e.change),
    ['200103', '200102', '200101']);
  assert.match(out, /^help\[1\]: Run `gerrit-axi show 200103 200102 200101 --comments`/m);
});

test('--rows caps every section, and the size hint names the query for the rest', async () => {
  const { out } = await run(['--rows', '1'], { ssh: DASHBOARD });
  assert.deepEqual(table(out, 'sections').map((s) => [s.section, s.count, s.shown, s.more]), [
    ['your_turn', '1', '1', 'false'],
    ['wip', '1', '1', 'false'],
    ['outgoing', '2', '1', 'true'],
    ['incoming', '2', '1', 'true'],
    ['cced', '0', '0', 'false'],
  ], 'count is what matched; shown is what this call emitted');
  assert.deepEqual(table(out, 'entries').map((e) => e.change),
    ['184458', '200103', '200102', '300202'], 'the newest row of each section survives');
  assert.match(out,
    /Run `gerrit-axi status --query 'owner:self status:open NOT is:wip'` for every outgoing change \(2 matched, 1 shown\)/);
  assert.match(out, /for every incoming change \(2 matched, 1 shown\)/);
  assert.equal(/for every (?:your_turn|wip|cced) change/.test(out), false,
    'a section shown whole gets no such hint');
});

test('a page the server cut short is flagged, and its count is marked as a floor', async () => {
  const { out } = await run([], { ssh: { ...DASHBOARD, 'cc:self': 'query-more.txt' } });
  const cced = table(out, 'sections').find((s) => s.section === 'cced');
  assert.deepEqual([cced?.count, cced?.shown, cced?.more], ['1', '1', 'true']);
  assert.match(out, /for every cced change \(1\+ matched, 1 shown\)/);
});

test('an empty section is stated, never omitted', async () => {
  // Nothing awaiting you is a fact about your day, so its row stays and says so.
  const quiet = await run([], { ssh: { ...DASHBOARD, 'attention:self': 'query-empty.txt' } });
  assert.equal(quiet.code, EXIT.ok);
  assert.deepEqual(table(quiet.out, 'sections')[0], {
    section: 'your_turn', count: '0', shown: '0', more: 'false', query: 'attention:self status:open',
  });
  assert.match(quiet.out, /^help\[1\]: Nothing awaits your attention\.$/m);

  // Nothing at all: every section present at zero, an empty table, and a way to
  // start. Under --json so the help lines can be compared exactly.
  const empty = Object.fromEntries(Object.keys(DASHBOARD).map((k) => [k, 'query-empty.txt']));
  const none = await run(['--json'], { ssh: empty });
  assert.equal(none.code, EXIT.ok);
  const document = JSON.parse(none.out);
  assert.equal(document.total, 0);
  assert.deepEqual(document.sections.map((/** @type {any} */ s) => [s.section, s.count, s.shown, s.more]), [
    ['your_turn', 0, 0, false],
    ['wip', 0, 0, false],
    ['outgoing', 0, 0, false],
    ['incoming', 0, 0, false],
    ['cced', 0, 0, false],
  ]);
  assert.deepEqual(document.entries, []);
  assert.deepEqual(document.help, [
    'No open change involves you.',
    'Run `gerrit-axi publish --stack --topic <t>` or `gerrit-axi publish --squash` to propose the commits on HEAD',
  ]);
  const toon = await run([], { ssh: empty });
  assert.match(toon.out, /^entries: \[\]$/m);
});

test('the dashboard under --json carries the same keys, typed', async () => {
  const { code, out } = await run(['--json'], { ssh: DASHBOARD });
  assert.equal(code, EXIT.ok);
  const document = JSON.parse(out);
  assert.deepEqual(Object.keys(document),
    ['ok', 'op', 'user', 'host', 'total', 'sections', 'entries', 'help']);
  assert.equal(document.op, 'dashboard');
  assert.equal(document.total, 6);
  assert.deepEqual(document.sections[2], {
    section: 'outgoing', count: 2, shown: 2, more: false, query: 'owner:self status:open NOT is:wip',
  });
  assert.equal(document.entries[0].change, 184458, 'a change number is a number');
  assert.equal(document.entries[3].submit, 'OK');
});

test('with no host to resolve, the dashboard is an error record, not usage', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main([], {
    cwd: '/nowhere',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runner: fakeRunner([
      { match: (f) => f === 'git', result: { code: 128, stderr: 'fatal: not a git repository' } },
    ]),
    fetchImpl: fakeFetch([]),
  });
  assert.equal(code, EXIT.config);
  assert.equal(stdout.text, '', 'nothing on stdout: not usage, not a partial dashboard');
  assert.match(stderr.text, /^ok: false$/m);
  assert.match(stderr.text, /^op: dashboard$/m);
  assert.match(stderr.text, /^code: HOST_UNRESOLVED$/m);
  assert.match(stderr.text, /^kind: config$/m);
  assert.match(stderr.text, /^remedy: /m);
  assert.equal(stderr.text.includes('usage:'), false);
});

test('the top-level help lists every option every subcommand takes', async () => {
  // The repo's own convention: an option discoverable only from a subcommand's
  // help gets missed. Read the flag names out of the parser's own tables so a
  // new one cannot be added without appearing here.
  const source = readFileSync(path.join(SRC_DIR, 'axi', 'main.js'), 'utf8');
  const specs = /const FLAG_SPECS = \{[\s\S]*?\n\};/.exec(source)?.[0] ?? '';
  assert.ok(specs, 'FLAG_SPECS should be readable from main.js');
  const flags = [...specs.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(flags.length >= 6, `expected the subcommand flags, found ${flags.join(' ')}`);

  const stdout = captureStream();
  await main(['--help'], {
    cwd: '/nowhere',
    env: {},
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner: fakeRunner([]),
  });
  for (const flag of [...new Set(flags)]) {
    assert.ok(stdout.text.includes(flag), `gerrit-axi --help must mention ${flag}`);
  }
  // ...and the global ones, which the parser also owns.
  for (const flag of ['--json', '--host', '--user', '--port', '--project', '--rest-base']) {
    assert.ok(stdout.text.includes(flag), `gerrit-axi --help must mention ${flag}`);
  }
});

test('the package declares both binaries and leaves the human one alone', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.gerrit, 'bin/gerrit.js', 'the human entry point is unchanged');
  assert.equal(pkg.bin['gerrit-axi'], 'bin/gerrit-axi.js');
  // The agent tier is reached by its own binary, not by a flag on the human one.
  const humanUsage = readFileSync(path.join(SRC_DIR, 'cli', 'main.js'), 'utf8');
  assert.equal(humanUsage.includes('--json'), false, 'the human CLI has no --json');
});

test('publish --stack is one push, answered with the changes the server now holds', async () => {
  const base = '0'.repeat(40);
  const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
  const record = (/** @type {string} */ sha, /** @type {string} */ parent, /** @type {string} */ subject) => [
    sha, sha, parent, 'Ada', 'ada@example.com', '1785600000 +0000', 'Ada', 'ada@example.com',
    '1785600000 +0000', `${subject}\n\nChange-Id: I${sha}\n`,
  ].join('\0') + '\0';
  const runner = fakeRunner([
    { match: (f, args) => f === 'git' && args.includes('remote'), result: { stdout: REMOTE } },
    {
      match: (f, args) => f === 'git' && args.includes('ls-remote'),
      result: { stdout: `ref: refs/heads/main\tHEAD\n${base}\tHEAD\n` },
    },
    { match: (f, args) => f === 'git' && args.includes(`${base}^{commit}`), result: { stdout: base } },
    { match: (f, args) => f === 'git' && args.includes('HEAD^{commit}'), result: { stdout: c } },
    { match: (f, args) => f === 'git' && args.includes('merge-base'), result: { stdout: base } },
    {
      match: (f, args) => f === 'git' && args.includes('log'),
      result: {
        stdout: record(a, base, 'Split the queue reader out of the daemon')
          + record(b, a, 'Give the queue reader its own retry ceiling')
          + record(c, b, 'Wire the retry ceiling to the managed configuration'),
      },
    },
    {
      match: (f, args) => f === 'git' && args.includes('push'),
      result: { stdout: `To x\n*\t${c}:refs/for/main%topic=stack-of-three\t[new reference]\nDone\n` },
    },
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-stack.txt') } },
  ]);
  const stdout = captureStream();
  const code = await main(['publish', '--stack', '--topic', 'stack-of-three'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runner,
    fetchImpl: fakeFetch([]),
  });
  assert.equal(code, EXIT.ok);

  const pushes = runner.calls.filter((call) => call.file === 'git' && call.args.includes('push'));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].args.at(-1), `${c}:refs/for/main%topic=stack-of-three`);

  assert.match(stdout.text, /^op: publish$/m);
  assert.match(stdout.text, /^shape: stack$/m);
  assert.match(stdout.text, /^new_patch_sets: true$/m);
  assert.match(stdout.text, /^rewritten_from: null$/m, 'every commit had its Change-Id, so the branch is untouched');
  const published = table(stdout.text, 'published');
  assert.deepEqual(published.map((p) => [p.change, p.change_id, p.stamped, p.patch_set, p.current]), [
    ['200101', `I${a}`, 'false', '4', 'true'],
    ['200102', `I${b}`, 'false', '2', 'true'],
    ['200103', `I${c}`, 'false', '1', 'true'],
  ]);
  // Joined to the same per-change table every other command emits.
  assert.deepEqual(table(stdout.text, 'changes').map((row) => [row.change, row.topic]), [
    ['200101', 'stack-of-three'],
    ['200102', 'stack-of-three'],
    ['200103', 'stack-of-three'],
  ]);
});

test('submit asks the server and nothing else, and reports what it merged', async () => {
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
  try {
    const { code, out, runner } = await run(['submit', '200101'], {
      fetchRoutes: [{
        path: '/a/changes/200101/submit',
        body: ")]}'\n" + JSON.stringify({
          _number: 200101,
          change_id: `I${'a'.repeat(40)}`,
          project: 'acme/apps/widget-console',
          branch: 'main',
          topic: 'stack-of-three',
          subject: 'Split the queue reader out of the daemon',
          status: 'MERGED',
        }),
      }],
    });
    assert.equal(code, EXIT.ok);
    // Readiness is the server's call at the moment of the submit, so nothing is
    // queried first to second-guess it.
    assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0);
    assert.match(out, /^op: submit$/m);
    assert.match(out, /^change: 200101$/m);
    assert.match(out, /^status: MERGED$/m);
    assert.match(out, /^topic: stack-of-three$/m);
  } finally {
    Session.prototype.token = restored;
  }
});

test('a submit the server refuses is an error record carrying the server\'s own words', async () => {
  const restored = Session.prototype.token;
  Session.prototype.token = async () => ({ token: 'placeholder-not-a-real-token', backend: 'file', location: null });
  try {
    const refusal = "Change 200102: submit requirement 'Zebu-Herding' is unsatisfied";
    const { code, out, err, runner } = await run(['submit', '200102', '--json'], {
      fetchRoutes: [{ path: '/a/changes/200102/submit', status: 409, body: refusal }],
    });
    assert.equal(code, EXIT.transport);
    assert.equal(out, '');
    assert.equal(runner.calls.filter((call) => call.file === 'ssh').length, 0);
    const record = JSON.parse(err);
    assert.deepEqual(
      { ok: record.ok, op: record.op, code: record.code, kind: record.kind },
      { ok: false, op: 'submit', code: 'SUBMIT_REFUSED', kind: 'transport' },
    );
    assert.equal(record.error, `Gerrit refused to submit change 200102: ${refusal}`);
  } finally {
    Session.prototype.token = restored;
  }
});

test('TOON: a table declares its own field names, and every value round-trips', () => {
  assert.equal(
    encode({ ok: true, op: 'show', count: 2 }),
    'ok: true\nop: show\ncount: 2',
  );
  assert.equal(
    encode({ rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] }),
    'rows[2]{a,b}:\n  1,x\n  2,y',
  );
  // Anything that could be read as a literal or as structure is quoted, so a
  // consumer can always tell a string from a number, a null or a delimiter.
  assert.equal(encode({ v: 'a,b' }), 'v: "a,b"');
  assert.equal(encode({ v: 'true' }), 'v: "true"');
  assert.equal(encode({ v: '42' }), 'v: "42"');
  assert.equal(encode({ v: '' }), 'v: ""');
  assert.equal(encode({ v: null }), 'v: null');
  assert.equal(encode({ v: 'has:colon' }), 'v: "has:colon"');
  assert.equal(encode({ v: 'line\nbreak' }), 'v: "line\\nbreak"');
  assert.equal(encode({ v: 'say "hi"' }), 'v: "say \\"hi\\""');
  assert.equal(encode({ v: '-lead' }), 'v: "-lead"');
  assert.equal(encode({ empty: [] }), 'empty: []');
  assert.equal(encode({ nums: [1, 2, 3] }), 'nums[3]: 1,2,3');
  assert.equal(encode({ outer: { inner: 'v' } }), 'outer:\n  inner: v');
  // A ragged array cannot be tabular, so it falls back to list items.
  assert.equal(
    encode({ mixed: [{ a: 1 }, { a: 1, b: 2 }] }),
    'mixed[2]:\n  - a: 1\n  - a: 1\n    b: 2',
  );
});

test('TOON: a non-finite number is null, not a bareword', () => {
  // TOON's number is JSON's, which has neither. `n: NaN` would be an unquoted
  // token that is not a literal: a decoder either rejects it or reads it as a
  // string, and a consumer comparing it to a number gets neither answer.
  assert.equal(encode({ n: NaN }), 'n: null');
  assert.equal(encode({ n: Infinity }), 'n: null');
  assert.equal(encode({ n: -Infinity }), 'n: null');
  // ...in every position a scalar can appear, not just as an object value.
  assert.equal(encode({ list: [NaN, 1, Infinity] }), 'list[3]: null,1,null');
  assert.equal(
    encode({ rows: [{ a: 1, b: NaN }, { a: -Infinity, b: 2 }] }),
    'rows[2]{a,b}:\n  1,null\n  null,2',
  );
  // Negative zero is finite and stays a number, as JSON has it.
  assert.equal(encode({ n: -0 }), 'n: 0');
  assert.equal(encode({ n: 1e21 }), 'n: 1e+21');
});

test('TOON: a generated document decodes back to what was encoded', () => {
  // The property behind the test above, checked over generated values rather
  // than named cases -- `NaN` reached the output as a bareword because no
  // example happened to carry one, and a bareword decodes as a string. The
  // reference point is JSON's own normalisation, which is what TOON's scalar
  // grammar follows: non-finite becomes null, undefined disappears.
  const values = [
    null, true, false, 0, -0, 1, -7, 3.5, 1e21, NaN, Infinity, -Infinity,
    '', 'a', 'a,b', 'true', '42', '007', ' pad ', '-x', 'x\ny', 'x\ty', '"q"', 'a\\b',
    'has:colon', 'Zebu-Herding', 'refs/changes/03/200103/1', 'héllo', 'two words',
  ];
  let seed = 1;
  const next = (/** @type {number} */ n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = () => values[next(values.length)];

  for (let i = 0; i < 400; i += 1) {
    // The shapes records.js actually produces: scalar fields, and one table of
    // uniformly-keyed scalar rows.
    const fields = ['change', 'label', 'status', 'by'].slice(0, 1 + next(4));
    /** @type {Record<string, unknown>} */
    const input = { ok: true, op: 'show', note: pick(), count: next(9) };
    input.rows = Array.from({ length: next(4) }, () => (
      Object.fromEntries(fields.map((f) => [f, pick()]))
    ));
    assert.deepEqual(decodeFlat(encode(input)), JSON.parse(JSON.stringify(input)));
  }
});

/**
 * A minimal, independent TOON reader for the flat shape this tier emits: `key:
 * scalar` lines and one `key[n]{fields}:` table. Written from the format rather
 * than from the encoder, so it disagrees when the encoder is wrong.
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
function decodeFlat(text) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const tabular = /^([A-Za-z_][\w.]*)\[(\d+)\]\{(.*)\}:$/.exec(lines[i]);
    if (tabular) {
      const fields = tabular[3].split(',');
      const rows = [];
      for (let n = 0; n < Number(tabular[2]); n += 1) {
        i += 1;
        const cells = splitRow(lines[i].slice(2), { raw: true });
        rows.push(Object.fromEntries(fields.map((f, j) => [f, scalar(cells[j])])));
      }
      out[tabular[1]] = rows;
      continue;
    }
    const inline = /^([A-Za-z_][\w.]*)\[(\d+)\]: (.*)$/.exec(lines[i]);
    if (inline) {
      out[inline[1]] = splitRow(inline[3], { raw: true }).map(scalar);
      continue;
    }
    const pair = /^([A-Za-z_][\w.]*): (.*)$/.exec(lines[i]);
    assert.ok(pair, `unreadable TOON line: ${JSON.stringify(lines[i])}`);
    out[pair[1]] = pair[2] === '[]' ? [] : scalar(pair[2]);
  }
  return out;
}

/**
 * @param {string} token  exactly as written
 * @returns {unknown}
 */
function scalar(token) {
  if (token === 'null') return null;
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return Number(token);
  if (token.startsWith('"')) {
    assert.ok(token.endsWith('"') && token.length >= 2, `unterminated string: ${token}`);
    return unescape(token.slice(1, -1));
  }
  return token; // a safe bareword is the string itself
}

/**
 * @param {string} body  a quoted field's contents, without the quotes
 * @returns {string}
 */
function unescape(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const next = body[i + 1];
    if (next === 'u') {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 2, i + 6), 16));
      i += 5;
      continue;
    }
    assert.ok(Object.hasOwn(UNESCAPE, next), `unknown escape \\${next} in ${body}`);
    out += UNESCAPE[next];
    i += 1;
  }
  return out;
}

test('the tier imports src/core and nothing from src/cli', () => {
  // The whole reason this tier exists: it is a sibling of the human CLI, not a
  // wrapper around it. See test/layering.test.js for the mechanical guard.
  const files = ['main.js', 'commands.js', 'records.js', 'output.js', 'args.js', 'toon.js'];
  for (const file of files) {
    const text = readFileSync(path.join(SRC_DIR, 'axi', file), 'utf8');
    assert.equal(/from\s+['"][^'"]*\/cli\//.test(text), false, `${file} must not import src/cli`);
    for (const match of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      assert.match(match[1], /^\.\.\/core\/|^\.\//, `${file} imports ${match[1]}`);
    }
  }
});

test('an origin remote whose username ssh would read as an option never reaches ssh', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    {
      match: (f, a) => f === 'git' && a.includes('remote'),
      result: { stdout: 'ssh://%2DoUser=eve@gerrit.example.com:29418/acme/one\n' },
    },
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-stack.txt') } },
  ]);
  for (const argv of [['status'], ['show', '200101']]) {
    const code = await main(argv, {
      cwd: '/some/checkout',
      env: ENV,
      stdout: stdout.stream,
      stderr: stderr.stream,
      runner,
    });
    assert.equal(code, EXIT.transport, argv.join(' '));
  }
  assert.equal(runner.calls.filter((c) => c.file === 'ssh').length, 0);
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /^code: UNSAFE_CONNECTION$/m);
  assert.equal(stderr.text.includes('oUser=eve'), false, 'the rejected value is echoed');
});
