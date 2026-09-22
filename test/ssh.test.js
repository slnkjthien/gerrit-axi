// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { TransportError } from '../src/core/errors.js';
import {
  DETAIL_QUERY_FLAGS,
  assertSafeQuery,
  buildSshArgs,
  parseQueryOutput,
  sshQuery,
} from '../src/core/ssh.js';
import { queryChanges } from '../src/core/changes.js';
import { Session } from '../src/core/session.js';
import { fakeRunner, fixture } from './helpers.js';

const CONN = { host: 'gerrit.example.com', port: 29418, user: 'ada' };

test('the query asks for the three flags the readiness oracle needs', () => {
  const args = buildSshArgs(CONN, 'attention:self status:open');
  for (const flag of ['--format=JSON', '--current-patch-set', '--all-approvals', '--submit-records']) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(args.slice(0, 6), ['-p', '29418', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
  assert.ok(args.includes('ada@gerrit.example.com'));
  assert.ok(args.includes('limit:100'));
});

test('optional detail is added only when asked for, and only from the allowlist', () => {
  const plain = buildSshArgs(CONN, 'change:184458');
  assert.equal(plain.includes('--comments'), false, 'a list view must not pay for message timelines');
  assert.equal(plain.includes('--dependencies'), false);

  const detailed = buildSshArgs(CONN, 'change:184458', { include: ['comments', 'dependencies'] });
  assert.ok(detailed.includes('--comments'));
  assert.ok(detailed.includes('--dependencies'));
  // Still before the query and the limit, which must stay the last two elements.
  assert.deepEqual(detailed.slice(-2), ['change:184458', 'limit:100']);
  assert.deepEqual(Object.keys(DETAIL_QUERY_FLAGS), ['comments', 'dependencies']);

  const repeated = buildSshArgs(CONN, 'change:1', { include: ['comments', 'comments'] });
  assert.equal(repeated.filter((a) => a === '--comments').length, 1);
});

test('a detail key the transport does not know is refused, never passed through', () => {
  // `include` names a key, never a flag: nothing a caller supplies reaches argv.
  for (const bad of ['--comments', 'patch-sets', 'constructor', '', '; id']) {
    assert.throws(() => buildSshArgs(CONN, 'change:1', { include: [bad] }), (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'UNSAFE_QUERY');
      assert.match(err.remedy, /comments, dependencies/);
      return true;
    }, `should have refused: ${bad}`);
  }
});

test('no credential is ever an element of the ssh argv', () => {
  const args = buildSshArgs(CONN, 'owner:self status:open');
  assert.equal(args.some((a) => /token|password|secret/i.test(a)), false);
});

test('the limit is honoured and validated', () => {
  assert.ok(buildSshArgs(CONN, 'status:open', { limit: 5 }).includes('limit:5'));
  assert.throws(() => buildSshArgs(CONN, 'status:open', { limit: 0 }), /invalid limit/);
  assert.throws(() => buildSshArgs(CONN, 'status:open', { limit: 1.5 }), /invalid limit/);
});

test('shell metacharacters are refused: host and port are data, not constants', () => {
  // `ssh` hands the remote command to a shell on anything that is not Gerrit, and
  // the host comes off a git remote, so this guard is not theoretical.
  for (const bad of [
    'status:open; rm -rf /',
    'status:open && whoami',
    'status:open | cat',
    'status:open `id`',
    'status:open $(id)',
    'status:open > /tmp/x',
    'status:open\nowner:self',
    'status:open \\; id',
  ]) {
    assert.throws(() => assertSafeQuery(bad), (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'UNSAFE_QUERY');
      return true;
    }, `should have refused: ${bad}`);
  }
});

test('ordinary Gerrit query syntax passes, including quoted phrases and grouping', () => {
  for (const good of [
    'attention:self status:open',
    'owner:self status:open',
    '(change:1 OR change:2)',
    'status:open -is:wip',
    'message:"flaky test"',
    'label:Some-Custom-Label=+2',
    'project:^acme/apps/.*',
    'branch:release/7.2 age:2d',
  ]) {
    assert.equal(assertSafeQuery(good), good);
  }
});

test('an empty query is refused', () => {
  assert.throws(() => assertSafeQuery(''), /empty Gerrit query/);
  assert.throws(() => assertSafeQuery('   '), /empty Gerrit query/);
});

test('parseQueryOutput splits the JSON lines and separates the stats row', () => {
  const { rows, stats } = parseQueryOutput(fixture('query-output.txt'));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.number), [184458, 184431, 184402]);
  assert.equal(stats.rowCount, 3);
  assert.equal(rows.some((r) => r.type === 'stats'), false);
});

test('blank lines are tolerated and a non-JSON line is reported', () => {
  assert.deepEqual(parseQueryOutput('\n\n').rows, []);
  assert.deepEqual(parseQueryOutput('').rows, []);
  assert.throws(() => parseQueryOutput('not json at all'), (err) => {
    assert.equal(err.code, 'BAD_RESPONSE');
    return true;
  });
});

test('a query the server rejected surfaces as an error, not an empty result', () => {
  const output = '{"type":"error","message":"Unsupported operator: nosuchoperator:x"}\n';
  assert.throws(() => parseQueryOutput(output), (err) => {
    assert.equal(err.code, 'GERRIT_ERROR');
    assert.match(err.message, /Unsupported operator/);
    return true;
  });
});

test('a non-zero ssh exit becomes an actionable transport error', async () => {
  const runner = fakeRunner([{
    match: (f) => f === 'ssh',
    result: { code: 255, stderr: 'Permission denied (publickey).\n' },
  }]);
  await assert.rejects(
    () => sshQuery(CONN, 'status:open', { runner }),
    (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'SSH_FAILED');
      assert.match(err.message, /Permission denied/);
      assert.match(err.remedy, /gerrit version/);
      return true;
    },
  );
});

test('a missing ssh binary is reported as such', async () => {
  const runner = /** @type {any} */ (async () => { throw new Error('spawn ssh ENOENT'); });
  await assert.rejects(() => sshQuery(CONN, 'status:open', { runner }), (err) => {
    assert.equal(err.code, 'SSH_FAILED');
    assert.match(err.remedy, /OpenSSH client/);
    return true;
  });
});

test('queryChanges drives the whole path from intent to typed models, offline', async () => {
  const runner = fakeRunner([
    { match: (f) => f === 'ssh', result: { stdout: fixture('query-output.txt') } },
  ]);
  const session = new Session({
    config: {
      host: 'gerrit.example.com',
      port: 29418,
      user: 'ada',
      project: null,
      restBase: 'https://gerrit.example.com',
      severityPatterns: [],
      sources: {},
      configPath: '/nonexistent/config.json',
    },
    env: {},
    runner,
  });

  const changes = await queryChanges(session, { kind: 'attention' }, { limit: 25 });
  assert.equal(changes.length, 3);
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].file, 'ssh');
  assert.ok(runner.calls[0].args.includes('attention:self status:open'));
  assert.ok(runner.calls[0].args.includes('limit:25'));
  assert.deepEqual(changes.map((c) => c.readiness.blocking), [
    ['Zebra-Check'],
    [],
    ['Release-Gate', 'Widget-Approval'],
  ]);
});

test('a user or host that begins with "-" never reaches ssh, which would read it as an option', async () => {
  for (const conn of [
    { host: 'gerrit.example.com', port: 29418, user: '-oUser=eve' },
    { host: '-oHostName=elsewhere', port: 29418, user: 'ada' },
  ]) {
    assert.throws(() => buildSshArgs(conn, 'status:open'), (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'UNSAFE_CONNECTION');
      return true;
    }, `buildSshArgs should have refused: ${JSON.stringify(conn)}`);

    const runner = fakeRunner([{ match: (f) => f === 'ssh', result: { stdout: '' } }]);
    await assert.rejects(() => sshQuery(conn, 'status:open', { runner }), (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'UNSAFE_CONNECTION');
      return true;
    }, `sshQuery should have refused: ${JSON.stringify(conn)}`);
    assert.equal(runner.calls.length, 0, 'ssh must not be spawned at all');
  }
});

test('the destination follows an explicit end-of-options marker', () => {
  const args = buildSshArgs(CONN, 'status:open');
  const marker = args.indexOf('--');
  assert.notEqual(marker, -1, 'no -- in the ssh argv');
  assert.equal(args[marker + 1], 'ada@gerrit.example.com');
  assert.equal(args.slice(0, marker).includes('ada@gerrit.example.com'), false);
});
