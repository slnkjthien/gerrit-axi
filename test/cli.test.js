// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end CLI tests. `main()` is driven with a fake subprocess runner and a
 * fake HTTP client, so these exercise argument parsing, config resolution,
 * transport and rendering together without a network or a Gerrit server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EXIT, main } from '../src/cli/main.js';
import { commonPathPrefix, table, truncate } from '../src/cli/render.js';
import { specFromArgs } from '../src/cli/commands/status.js';
import { parseArgs } from '../src/cli/args.js';
import { captureStream, fakeFetch, fakeRunner, fixture } from './helpers.js';

const ENV = { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', NO_COLOR: '1', PATH: '' };
const REMOTE = 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console\n';

/**
 * @param {{queryOutput?: string, sshCode?: number, sshStderr?: string}} [opts]
 */
function io({ queryOutput = fixture('query-output.txt'), sshCode = 0, sshStderr = '' } = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
    { match: (f) => f === 'ssh', result: { code: sshCode, stdout: queryOutput, stderr: sshStderr } },
  ]);
  return {
    stdout,
    stderr,
    runner,
    args: {
      cwd: '/some/checkout',
      env: ENV,
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: /** @type {any} */ ({ isTTY: false }),
      runner,
    },
  };
}

test('gerrit status renders the attention set with a BLOCKED-ON column', async () => {
  const { args, stdout, stderr, runner } = io();
  const code = await main(['status'], args);

  assert.equal(code, EXIT.ok);
  const lines = stdout.text.trimEnd().split('\n');
  assert.match(lines[0], /^CHANGE\s+PROJECT\s+BRANCH\s+UPDATED\s+SUBMIT\s+BLOCKED-ON\s+SUBJECT$/);
  assert.equal(lines.length, 4, 'a header plus three changes');

  // Newest first.
  assert.deepEqual(lines.slice(1).map((l) => l.trimStart().split(/\s+/)[0]), ['184431', '184458', '184402']);

  // The blocking label is the server's, printed verbatim.
  const blocked = lines.find((l) => l.includes('184458'));
  assert.match(blocked, /NOT_READY\s+Zebra-Check/);
  const ready = lines.find((l) => l.includes('184431'));
  assert.match(ready, /OK\s+-\s/);

  // The shared project prefix is derived and announced, not configured.
  assert.match(stderr.text, /projects under acme\//);
  assert.match(blocked, /apps\/widget-console/);

  // The query the CLI asked for.
  const sshCall = runner.calls.find((c) => c.file === 'ssh');
  assert.ok(sshCall.args.includes('attention:self status:open'));
});

test('gerrit status mine asks for the caller\'s own open changes', async () => {
  const { args, runner } = io();
  assert.equal(await main(['status', 'mine'], args), EXIT.ok);
  assert.ok(runner.calls.find((c) => c.file === 'ssh').args.includes('owner:self status:open'));
});

test('gerrit status <change>... asks for exactly those changes', async () => {
  const { args, runner } = io();
  assert.equal(await main(['status', '184458', '184431'], args), EXIT.ok);
  assert.ok(runner.calls.find((c) => c.file === 'ssh').args.includes('(change:184458 OR change:184431)'));
});

test('gerrit status --query passes the query through', async () => {
  const { args, runner } = io();
  assert.equal(await main(['status', '--query', 'project:acme/one status:open'], args), EXIT.ok);
  assert.ok(runner.calls.find((c) => c.file === 'ssh').args.includes('project:acme/one status:open'));
});

test('a non-numeric positional is a usage error, not a query', async () => {
  const { args, stderr, runner } = io();
  assert.equal(await main(['status', 'everything'], args), EXIT.usage);
  assert.match(stderr.text, /not a change number: everything/);
  assert.equal(runner.calls.some((c) => c.file === 'ssh'), false, 'must not have queried');
});

test('--labels enumerates whatever labels the result set mentions', async () => {
  const { args, stdout } = io();
  assert.equal(await main(['status', '--labels'], args), EXIT.ok);
  const header = stdout.text.split('\n')[0];
  assert.match(header, /Release-Gate/);
  assert.match(header, /Widget-Approval/);
  assert.match(header, /Zebra-Check/);
  assert.equal(header.includes('BLOCKED-ON'), false, '--labels replaces the summary column');
});

test('an empty result set says so plainly', async () => {
  const { args, stdout } = io({ queryOutput: '{"type":"stats","rowCount":0}\n' });
  assert.equal(await main(['status'], args), EXIT.ok);
  assert.equal(stdout.text.trim(), 'nothing needs your attention');
});

test('an ssh failure exits with the transport code and an actionable message', async () => {
  const { args, stderr } = io({ sshCode: 255, sshStderr: 'Permission denied (publickey).' });
  assert.equal(await main(['status'], args), EXIT.transport);
  assert.match(stderr.text, /Permission denied/);
  assert.match(stderr.text, /gerrit version/);
});

test('outside a Gerrit repo with no config, the host is unresolved and the fix is printed', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f) => f === 'git', result: { code: 128, stderr: 'fatal: not a git repository' } },
  ]);
  const code = await main(['status'], {
    cwd: '/tmp',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner,
  });

  assert.equal(code, EXIT.config);
  assert.match(stderr.text, /cannot determine the Gerrit host/);
  assert.match(stderr.text, /GERRIT_HOST/);
  assert.match(stderr.text, /--host/);
});

test('inside a repo hosted somewhere other than Gerrit, nothing is dialled', async () => {
  // The regression this guards: a non-Gerrit remote used to parse cleanly, be
  // trusted, and cost ten seconds of SSH connect timeout at a port nobody serves.
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    {
      match: (f, a) => f === 'git' && a.includes('remote'),
      result: { stdout: 'git@github.com:owner/repo.git\n' },
    },
  ]);
  const code = await main(['status'], {
    cwd: '/some/checkout',
    env: ENV,
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner,
  });

  assert.equal(code, EXIT.config);
  assert.equal(runner.calls.some((c) => c.file === 'ssh'), false, 'must not have dialled anything');
  assert.match(stderr.text, /cannot determine the Gerrit host/);
  assert.match(stderr.text, /is not a Gerrit remote/);
  assert.match(stderr.text, /GERRIT_HOST/);
});

test('gerrit comments renders inline comments and marks the machine-generated ones', async () => {
  const stdout = captureStream();
  const stderr = captureStream();
  const runner = fakeRunner([
    { match: (f) => f === 'git', result: { stdout: REMOTE } },
    // loadToken probes the keyring with an empty PATH, so nothing is found; the
    // fake credential is injected below instead of writing one anywhere.
  ]);
  const fetchImpl = fakeFetch([{ path: '/comments', body: fixture('comments-body.txt') }]);

  // main() constructs the Session itself, so there is no instance to hand a
  // token to. Stub the accessor for the duration of this test instead; nothing is
  // written to a keyring or to disk.
  const { Session } = await import('../src/core/session.js');
  const original = Session.prototype.token;
  Session.prototype.token = async () => ({
    token: 'placeholder-not-a-real-token',
    backend: 'file',
    location: null,
  });
  try {
    const code = await main(['comments', '184458'], {
      cwd: '/some/checkout',
      env: ENV,
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: /** @type {any} */ ({ isTTY: false }),
      runner,
      fetchImpl,
    });
    assert.equal(code, EXIT.ok);
  } finally {
    Session.prototype.token = original;
  }

  const text = stdout.text;
  assert.match(text, /\(change\)\s+\[ps3\]\s+<review-assistant · ai-review>/);
  assert.match(text, /Queue\.java:42\s+\[ps3\]\s+UNRESOLVED\s+<grace>/);
  assert.match(text, /Retry\.java:5\s+\[ps3\]\s+<review-assistant · lint-suggest>/);
  // No severity column, because no severity patterns are configured.
  assert.equal(text.includes('[issue]  '), false);
  assert.match(text, /\[issue\] Possible null dereference/, 'the raw message is still printed');
});

test('comments rejects a non-numeric change and both filters at once', async () => {
  const { args, stderr } = io();
  assert.equal(await main(['comments', 'HEAD'], args), EXIT.usage);
  assert.match(stderr.text, /not a change number: HEAD/);

  const second = io();
  assert.equal(await main(['comments', '1', '--bots', '--humans'], second.args), EXIT.usage);
  assert.match(second.stderr.text, /mutually exclusive/);
});

test('auth login fails immediately without a TTY rather than blocking on a prompt', async () => {
  const { args, stderr } = io();
  const code = await main(['auth', 'login'], args);
  assert.equal(code, EXIT.error);
  assert.match(stderr.text, /no interactive terminal available/);
  assert.match(stderr.text, /--stdin/);
});

test('help and version work with no config, no repo and no network', async () => {
  for (const argv of [[], ['--help'], ['help'], ['--version'], ['status', '--help'], ['auth', '--help']]) {
    const stdout = captureStream();
    const stderr = captureStream();
    const runner = fakeRunner([]); // any subprocess at all would throw
    const code = await main(argv, {
      cwd: '/tmp',
      env: ENV,
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: /** @type {any} */ ({ isTTY: false }),
      runner,
    });
    assert.ok(code === EXIT.ok || code === EXIT.usage, `unexpected exit for ${argv.join(' ')}`);
    assert.ok(stdout.text.length > 0, `no output for ${argv.join(' ')}`);
  }
});

test('the help text states that v0.1 is read-only', async () => {
  const stdout = captureStream();
  await main(['--help'], {
    cwd: '/tmp',
    env: ENV,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([]),
  });
  assert.match(stdout.text, /read-only/);
});

test('an unknown command and an unknown option are usage errors', async () => {
  const { args, stderr } = io();
  assert.equal(await main(['frobnicate'], args), EXIT.usage);
  assert.match(stderr.text, /unknown command: frobnicate/);

  const second = io();
  assert.equal(await main(['status', '--wat'], second.args), EXIT.usage);
  assert.match(second.stderr.text, /unknown option: --wat/);
});

test('--query cannot be combined with positional change numbers', () => {
  const args = parseArgs(['--query', 'status:open', '184458'], {
    withValue: new Set(['--query']),
    boolean: new Set(),
  });
  assert.throws(() => specFromArgs(args), /cannot be combined/);
});

test('the common project prefix is derived from the rows, never assumed', () => {
  assert.equal(commonPathPrefix(['acme/apps/one', 'acme/apps/two']), 'acme/apps/');
  assert.equal(commonPathPrefix(['acme/apps/one', 'acme/tools/two']), 'acme/');
  assert.equal(commonPathPrefix(['acme/one', 'other/two']), '');
  assert.equal(commonPathPrefix(['acme/apps/one']), '', 'a single row is never abbreviated');
  assert.equal(commonPathPrefix([]), '');
  // The last segment is never swallowed, even when two rows are identical.
  assert.equal(commonPathPrefix(['acme/apps/one', 'acme/apps/one']), 'acme/apps/');
});

test('a long blocking list truncates without cutting an ANSI escape in half', async () => {
  // Colour on, and more blocking labels than the column can hold.
  const labels = ['Aardvark-Review', 'Bandicoot-Gate', 'Capybara-Check', 'Dingo-Approval'];
  const row = {
    project: 'acme/one',
    branch: 'main',
    id: 'I1',
    number: 1,
    subject: 'Something',
    lastUpdated: 1753900000,
    submitRecords: [{
      status: 'NOT_READY',
      labels: labels.map((label) => ({ label, status: 'NEED' })),
    }],
  };

  const stdout = captureStream();
  const stderr = captureStream();
  const code = await main(['status'], {
    cwd: '/some/checkout',
    env: { XDG_CONFIG_HOME: '/nonexistent-xdg-for-tests', FORCE_COLOR: '1', PATH: '' },
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: /** @type {any} */ ({ isTTY: false }),
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('remote'), result: { stdout: REMOTE } },
      { match: (f) => f === 'ssh', result: { stdout: `${JSON.stringify(row)}\n` } },
    ]),
  });

  assert.equal(code, EXIT.ok);
  const text = stdout.text;
  assert.ok(text.includes('\u001b['), 'colour should be on for this test to mean anything');
  // Every escape sequence introduced must be a complete, well-formed one.
  for (const match of text.match(/\u001b\[?[^m]*m?/g) ?? []) {
    assert.match(match, /^\u001b\[[0-9;]*m$/, `malformed escape sequence: ${JSON.stringify(match)}`);
  }
  // 34 visible characters, with the colour wrapping the already-truncated text.
  assert.match(text, /\u001b\[31mAardvark-Review,Bandicoot-Gate,Ca…\u001b\[0m/);
});

test('the table aligns columns and truncates on request', () => {
  const lines = table(
    [{ a: 'x', b: 'longer value' }, { a: 'yyyy', b: 'z' }],
    [{ header: 'A', value: (r) => r.a }, { header: 'B', value: (r) => r.b, max: 6 }],
  );
  assert.deepEqual(lines, ['A     B', 'x     longe…', 'yyyy  z']);
  assert.equal(truncate('abcdef', 3), 'ab…');
  assert.equal(truncate('abc', 10), 'abc');
});
