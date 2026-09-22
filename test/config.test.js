// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import {
  DEFAULT_SSH_PORT,
  acceptGerritRemote,
  parseRemoteUrl,
  readGitRemoteUrl,
} from '../src/core/remote.js';
import { resolveConfig } from '../src/core/config.js';
import { ConfigError, TransportError } from '../src/core/errors.js';
import { fakeRunner } from './helpers.js';

const NO_CONFIG_FILE = async () => {
  const err = new Error('ENOENT');
  /** @type {any} */ (err).code = 'ENOENT';
  throw err;
};

test('parses a Gerrit SSH remote into host, port, user and project', () => {
  const parsed = parseRemoteUrl('ssh://ada@gerrit.example.com:29418/acme/apps/widget-console');
  assert.deepEqual(parsed, {
    host: 'gerrit.example.com',
    port: 29418,
    user: 'ada',
    project: 'acme/apps/widget-console',
    scheme: 'ssh',
    restBase: null,
    shape: 'gerrit',
  });
});

test('parses an SSH remote with a non-default port and a .git suffix', () => {
  const parsed = parseRemoteUrl('ssh://ada@review.example.org:2222/acme/tools/hammer.git');
  assert.equal(parsed?.port, 2222);
  assert.equal(parsed?.project, 'acme/tools/hammer');
});

test('an SSH remote without an explicit port gets Gerrit\'s well-known port', () => {
  const parsed = parseRemoteUrl('ssh://gerrit.example.com/acme/one');
  assert.equal(parsed?.port, DEFAULT_SSH_PORT);
  assert.equal(parsed?.user, null);
});

test('an HTTPS remote yields a REST base and drops Gerrit\'s /a/ prefix', () => {
  const parsed = parseRemoteUrl('https://ada@gerrit.example.com/a/acme/apps/widget-console');
  assert.equal(parsed?.host, 'gerrit.example.com');
  assert.equal(parsed?.project, 'acme/apps/widget-console');
  assert.equal(parsed?.user, 'ada');
  assert.equal(parsed?.restBase, 'https://gerrit.example.com');
});

test('a web port on an HTTPS remote never becomes the SSH port', () => {
  const parsed = parseRemoteUrl('https://gerrit.example.com:8443/acme/one');
  assert.equal(parsed?.port, DEFAULT_SSH_PORT, 'SSH port must not be taken from a web URL');
  assert.equal(parsed?.restBase, 'https://gerrit.example.com:8443');
});

test('parses the scp-style remote form', () => {
  const parsed = parseRemoteUrl('ada@gerrit.example.com:acme/one.git');
  assert.equal(parsed?.host, 'gerrit.example.com');
  assert.equal(parsed?.user, 'ada');
  assert.equal(parsed?.project, 'acme/one');
  assert.equal(parsed?.port, DEFAULT_SSH_PORT);
});

test('unaddressable remotes parse to null rather than a guess', () => {
  assert.equal(parseRemoteUrl(''), null);
  assert.equal(parseRemoteUrl(null), null);
  assert.equal(parseRemoteUrl('/srv/git/local-repo.git'), null);
  assert.equal(parseRemoteUrl('file:///srv/git/local-repo.git'), null);
});

test('a remote URL is classified by how Gerrit-shaped it is', () => {
  // Gerrit advertises its sshd port, and its authenticated HTTP clone URL carries
  // the /a/ prefix. Only Gerrit publishes either.
  assert.equal(parseRemoteUrl('ssh://ada@gerrit.example.com:29418/acme/one')?.shape, 'gerrit');
  assert.equal(parseRemoteUrl('ssh://ada@review.example.org:2222/acme/one')?.shape, 'gerrit');
  assert.equal(parseRemoteUrl('https://ada@gerrit.example.com/a/acme/one')?.shape, 'gerrit');
  assert.equal(parseRemoteUrl('http://gerrit.example.com/a/acme/one.git')?.shape, 'gerrit');

  // Shapes Gerrit publishes but so does everyone else: not trusted on their own.
  assert.equal(parseRemoteUrl('ssh://git@github.com/owner/repo.git')?.shape, 'ambiguous');
  assert.equal(parseRemoteUrl('https://github.com/owner/repo.git')?.shape, 'ambiguous');
  assert.equal(parseRemoteUrl('https://gerrit.example.com/acme/one')?.shape, 'ambiguous');

  // Gerrit does not publish the scp-style form at all, and it cannot say a port.
  assert.equal(parseRemoteUrl('git@github.com:owner/repo.git')?.shape, 'foreign');
  assert.equal(parseRemoteUrl('ada@gerrit.example.com:acme/one.git')?.shape, 'foreign');
});

test('an scp-style GitHub remote contributes nothing and the environment answers', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'gerrit.example.com', GERRIT_USER: 'ada' },
    remoteUrl: 'git@github.com:owner/repo.git',
    readFile: NO_CONFIG_FILE,
    // Nothing may be probed: the shape alone settles it, so an unexpected
    // subprocess here is a failure.
    runner: fakeRunner([]),
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.sources.host, 'env');
  // The remote's fields fall away as a unit -- no 'git' user, no 'owner/repo'.
  assert.equal(config.user, 'ada');
  assert.equal(config.project, null);
  assert.equal(config.port, 29418);
  assert.equal(config.sources.port, 'derived');
  assert.equal(config.restBase, 'https://gerrit.example.com');
});

test('an https GitHub remote with no corroborating repo evidence is ignored', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'gerrit.example.com', GERRIT_USER: 'ada' },
    remoteUrl: 'https://github.com/owner/repo.git',
    readFile: NO_CONFIG_FILE,
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('--get-all'), result: { code: 1 } },
      {
        match: (f, a) => f === 'git' && a.includes('--git-path'),
        result: { stdout: '.git/hooks/commit-msg\n' },
      },
    ]),
    readRepoFile: async () => {
      const err = new Error('ENOENT');
      /** @type {any} */ (err).code = 'ENOENT';
      throw err;
    },
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.sources.host, 'env');
  assert.equal(config.project, null);
  // The rejected remote's own origin must not become the REST base either.
  assert.equal(config.restBase, 'https://gerrit.example.com');
});

test('a rejected remote falls through to the config file when the environment is empty', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent' },
    remoteUrl: 'git@github.com:owner/repo.git',
    readFile: async () => JSON.stringify({ host: 'file.example.com', user: 'fileuser', port: 2300 }),
    runner: fakeRunner([]),
  });

  assert.equal(config.host, 'file.example.com');
  assert.equal(config.user, 'fileuser');
  assert.equal(config.port, 2300);
  assert.equal(config.sources.host, 'config-file');
  assert.equal(config.project, null);
});

test('a rejected remote with nothing else configured says the remote was ignored', async () => {
  await assert.rejects(
    () => resolveConfig({}, {
      env: { XDG_CONFIG_HOME: '/nonexistent' },
      remoteUrl: 'git@github.com:owner/repo.git',
      readFile: NO_CONFIG_FILE,
      runner: fakeRunner([]),
    }),
    (err) => {
      assert.ok(err instanceof ConfigError, 'must be a ConfigError');
      assert.equal(err.code, 'HOST_UNRESOLVED');
      // Named, so it does not read as though the repo had no remote at all...
      assert.match(err.remedy, /git@github\.com:owner\/repo\.git/);
      assert.match(err.remedy, /is not a Gerrit remote/);
      // ...and the remedy block is still the whole of it.
      assert.match(err.remedy, /GERRIT_HOST/);
      assert.match(err.remedy, /config\.json/);
      assert.match(err.remedy, /--host/);
      return true;
    },
  );
});

test('the unresolved-host error stays silent about a remote when there is none', async () => {
  await assert.rejects(
    () => resolveConfig({}, {
      env: { XDG_CONFIG_HOME: '/nonexistent' },
      remoteUrl: null,
      readFile: NO_CONFIG_FILE,
    }),
    (err) => {
      assert.equal(err.remedy.includes('is not a Gerrit remote'), false);
      return true;
    },
  );
});

test('a Gerrit ssh:// remote resolves all four fields, with nothing probed', async () => {
  const runner = fakeRunner([]);
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent' },
    remoteUrl: 'ssh://ada@gerrit.example.com:29418/acme/apps/widget-console',
    readFile: NO_CONFIG_FILE,
    runner,
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.port, 29418);
  assert.equal(config.user, 'ada');
  assert.equal(config.project, 'acme/apps/widget-console');
  assert.equal(config.sources.host, 'git-remote');
  assert.deepEqual(runner.calls, [], 'a Gerrit-shaped URL needs no corroboration');
});

test('a Gerrit https remote with the /a/ prefix resolves host, project and REST base', async () => {
  const runner = fakeRunner([]);
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent' },
    remoteUrl: 'https://ada@gerrit.example.com/a/acme/apps/widget-console',
    readFile: NO_CONFIG_FILE,
    runner,
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.user, 'ada');
  assert.equal(config.project, 'acme/apps/widget-console');
  assert.equal(config.restBase, 'https://gerrit.example.com');
  assert.equal(config.port, DEFAULT_SSH_PORT, 'an https remote says nothing about sshd');
  assert.deepEqual(runner.calls, []);
});

test('Gerrit\'s commit-msg hook corroborates an ambiguous remote', async () => {
  // A Gerrit site whose anonymous https clone URL carries no /a/ prefix: the URL
  // alone cannot be told from any other forge's, but the repo can.
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com' },
    remoteUrl: 'https://gerrit.example.com/acme/apps/widget-console',
    readFile: NO_CONFIG_FILE,
    runner: fakeRunner([
      { match: (f, a) => f === 'git' && a.includes('--get-all'), result: { code: 1 } },
      {
        match: (f, a) => f === 'git' && a.includes('--git-path'),
        result: { stdout: 'hooks/commit-msg\n' },
      },
    ]),
    readRepoFile: async () => '#!/bin/sh\n# Gerrit hook: adds a Change-Id to the message.\n',
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.sources.host, 'git-remote', 'the corroborated remote outranks the env');
  assert.equal(config.project, 'acme/apps/widget-console');
});

test('a refs/for refspec corroborates an ambiguous ssh remote', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com' },
    remoteUrl: 'ssh://ada@gerrit.example.com/acme/one',
    readFile: NO_CONFIG_FILE,
    runner: fakeRunner([
      {
        match: (f, a) => f === 'git' && a.includes('--get-all'),
        result: { stdout: 'HEAD:refs/for/main\n' },
      },
    ]),
  });

  assert.equal(config.host, 'gerrit.example.com');
  assert.equal(config.user, 'ada');
  assert.equal(config.port, DEFAULT_SSH_PORT);
  assert.equal(config.sources.host, 'git-remote');
});

test('acceptGerritRemote treats a missing git as no evidence rather than an error', async () => {
  const parsed = parseRemoteUrl('https://github.com/owner/repo.git');
  const verdict = await acceptGerritRemote(parsed, {
    cwd: '/some/checkout',
    runner: async () => { throw new Error('spawn git ENOENT'); },
  });
  assert.deepEqual(verdict, { remote: null, shape: 'ambiguous', evidence: null });

  assert.deepEqual(
    await acceptGerritRemote(null, { runner: async () => { throw new Error('unused'); } }),
    { remote: null, shape: 'absent', evidence: null },
  );
});

test('readGitRemoteUrl returns null outside a repo instead of throwing', async () => {
  const runner = fakeRunner([
    { match: (f) => f === 'git', result: { code: 128, stderr: 'fatal: not a git repository' } },
  ]);
  assert.equal(await readGitRemoteUrl({ cwd: '/tmp', runner }), null);
});

test('the origin remote outranks the environment and the config file', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com', GERRIT_USER: 'envuser', GERRIT_PORT: '2200' },
    remoteUrl: 'ssh://ada@remote.example.com:29418/acme/apps/widget-console',
    readFile: async () => JSON.stringify({ host: 'file.example.com', user: 'fileuser', port: 2300 }),
  });

  assert.equal(config.host, 'remote.example.com');
  assert.equal(config.user, 'ada');
  assert.equal(config.port, 29418);
  assert.equal(config.project, 'acme/apps/widget-console');
  assert.equal(config.sources.host, 'git-remote');
  assert.equal(config.sources.user, 'git-remote');
});

test('the environment is used when there is no usable origin remote', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com', GERRIT_USER: 'envuser', GERRIT_PORT: '2200' },
    remoteUrl: null,
    readFile: async () => JSON.stringify({ host: 'file.example.com', user: 'fileuser' }),
  });

  assert.equal(config.host, 'env.example.com');
  assert.equal(config.user, 'envuser');
  assert.equal(config.port, 2200);
  assert.equal(config.sources.host, 'env');
  assert.equal(config.sources.port, 'env');
});

test('the config file is used when neither the remote nor the environment answers', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent' },
    remoteUrl: null,
    readFile: async () => JSON.stringify({ host: 'file.example.com', user: 'fileuser', port: 2300 }),
  });

  assert.equal(config.host, 'file.example.com');
  assert.equal(config.user, 'fileuser');
  assert.equal(config.port, 2300);
  assert.equal(config.sources.host, 'config-file');
});

test('an explicit override outranks every tier', async () => {
  const config = await resolveConfig({ host: 'flag.example.com', user: 'flaguser', port: '2400' }, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com' },
    remoteUrl: 'ssh://ada@remote.example.com:29418/acme/one',
    readFile: async () => JSON.stringify({ host: 'file.example.com' }),
  });

  assert.equal(config.host, 'flag.example.com');
  assert.equal(config.user, 'flaguser');
  assert.equal(config.port, 2400);
  assert.equal(config.sources.host, 'override');
});

test('with nothing to derive from, the host is unresolved and the error says how to fix it', async () => {
  await assert.rejects(
    () => resolveConfig({}, {
      env: { XDG_CONFIG_HOME: '/nonexistent' },
      remoteUrl: null,
      readFile: NO_CONFIG_FILE,
    }),
    (err) => {
      assert.ok(err instanceof ConfigError, 'must be a ConfigError');
      assert.equal(err.code, 'HOST_UNRESOLVED');
      assert.match(err.message, /cannot determine the Gerrit host/);
      // The remedy must name all three tiers plus the escape hatch.
      assert.match(err.remedy, /origin/);
      assert.match(err.remedy, /GERRIT_HOST/);
      assert.match(err.remedy, /config\.json/);
      assert.match(err.remedy, /--host/);
      return true;
    },
  );
});

test('a missing config file is not an error', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com', GERRIT_USER: 'envuser' },
    remoteUrl: null,
    readFile: NO_CONFIG_FILE,
  });
  assert.equal(config.host, 'env.example.com');
  assert.deepEqual(config.severityPatterns, []);
});

test('a malformed config file is reported, not ignored', async () => {
  await assert.rejects(
    () => resolveConfig({}, {
      env: { XDG_CONFIG_HOME: '/nonexistent' },
      remoteUrl: null,
      readFile: async () => '{ this is not json',
    }),
    (err) => {
      assert.equal(err.code, 'BAD_CONFIG_FILE');
      return true;
    },
  );
});

test('the REST base defaults to https on the resolved host', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com', GERRIT_USER: 'envuser' },
    remoteUrl: null,
    readFile: NO_CONFIG_FILE,
  });
  assert.equal(config.restBase, 'https://env.example.com');
  assert.equal(config.sources.restBase, 'derived');
});

test('an out-of-range port is rejected', async () => {
  await assert.rejects(
    () => resolveConfig({ port: '99999' }, {
      env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'env.example.com', GERRIT_USER: 'u' },
      remoteUrl: null,
      readFile: NO_CONFIG_FILE,
    }),
    /invalid Gerrit SSH port/,
  );
});

test('a username that begins with "-" is refused whichever tier supplied it', async () => {
  const hostile = '-oUser=eve';
  for (const [source, overrides, deps] of [
    ['override', { user: hostile }, {
      remoteUrl: 'ssh://ada@gerrit.example.com:29418/acme/one', readFile: NO_CONFIG_FILE,
    }],
    ['git-remote', {}, {
      remoteUrl: 'ssh://%2DoUser=eve@gerrit.example.com:29418/acme/one', readFile: NO_CONFIG_FILE,
    }],
    ['env', {}, {
      env: { GERRIT_HOST: 'gerrit.example.com', GERRIT_USER: hostile }, readFile: NO_CONFIG_FILE,
    }],
    ['config-file', {}, {
      readFile: async () => JSON.stringify({ host: 'gerrit.example.com', user: hostile }),
    }],
  ]) {
    await assert.rejects(
      () => resolveConfig(overrides, {
        remoteUrl: null,
        ...deps,
        env: { XDG_CONFIG_HOME: '/nonexistent', ...deps.env },
      }),
      (err) => {
        assert.ok(err instanceof TransportError, `${source}: must be a TransportError`);
        assert.equal(err.code, 'UNSAFE_CONNECTION');
        assert.match(err.message, /username/);
        assert.match(err.message, new RegExp(source));
        // The rejected value is someone else's text: it is named, never echoed.
        assert.equal(err.message.includes(hostile), false, `${source}: message echoes the value`);
        assert.equal(String(err.remedy).includes(hostile), false, `${source}: remedy echoes the value`);
        return true;
      },
      `should have refused a username from ${source}`,
    );
  }
});

test('a local login name that begins with "-" is refused too', async (t) => {
  t.mock.method(os, 'userInfo', () => ({ username: '-oUser=eve' }));
  await assert.rejects(
    () => resolveConfig({}, {
      env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'gerrit.example.com' },
      remoteUrl: null,
      readFile: NO_CONFIG_FILE,
    }),
    (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'UNSAFE_CONNECTION');
      assert.match(err.message, /username/);
      assert.match(err.message, /derived/);
      return true;
    },
  );
});

test('a host that begins with "-" is refused whichever tier supplied it', async () => {
  const hostile = '-oHostName=elsewhere';
  for (const [source, overrides, deps] of [
    ['override', { host: hostile }, { readFile: NO_CONFIG_FILE }],
    ['git-remote', {}, {
      remoteUrl: 'ssh://ada@-oHostName=elsewhere:29418/acme/one', readFile: NO_CONFIG_FILE,
    }],
    ['env', {}, { env: { GERRIT_HOST: hostile }, readFile: NO_CONFIG_FILE }],
    ['config-file', {}, { readFile: async () => JSON.stringify({ host: hostile }) }],
  ]) {
    await assert.rejects(
      () => resolveConfig({ user: 'ada', ...overrides }, {
        remoteUrl: null,
        ...deps,
        env: { XDG_CONFIG_HOME: '/nonexistent', ...deps.env },
      }),
      (err) => {
        assert.ok(err instanceof TransportError, `${source}: must be a TransportError`);
        assert.equal(err.code, 'UNSAFE_CONNECTION');
        assert.match(err.message, /host/);
        assert.match(err.message, new RegExp(source));
        assert.equal(err.message.includes(hostile), false, `${source}: message echoes the value`);
        assert.equal(String(err.remedy).includes(hostile), false, `${source}: remedy echoes the value`);
        return true;
      },
      `should have refused a host from ${source}`,
    );
  }
});
