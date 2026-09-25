// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-store tests.
 *
 * These touch the real filesystem, but only inside a fresh temp directory, and
 * the "secret" is the placeholder string from helpers.js -- never a credential,
 * and never written anywhere inside the repo. The keyring backend is exercised
 * against a stub executable rather than the user's actual login keyring.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearToken,
  detectBackend,
  hasStoredToken,
  loadToken,
  requireToken,
  saveToken,
} from '../src/core/credentials.js';
import { AuthError } from '../src/core/errors.js';
import { PLACEHOLDER_TOKEN } from './helpers.js';

/**
 * A temp XDG_CONFIG_HOME plus an empty PATH, so no real backend is discovered and
 * the file fallback is what gets tested.
 */
async function tempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gerrit-axi-test-'));
  return {
    dir,
    env: { XDG_CONFIG_HOME: dir, PATH: '' },
    cleanup: () => fs.rm(dir, { recursive: true, force: true }),
  };
}

test('with no keyring and no gpg key, the backend is the plaintext file', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  assert.equal(await detectBackend({ env: home.env }), 'file');
});

test('the file backend round-trips, and says out loud that it is plaintext', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const id = { host: 'gerrit.example.com', user: 'ada', env: home.env };

  const store = await saveToken(PLACEHOLDER_TOKEN, id);
  assert.equal(store.backend, 'file');
  assert.equal(store.encryptedAtRest, false, 'the caller must be able to see this is plaintext');
  assert.match(store.upgradeHint ?? '', /secret-tool|GPG/);

  const loaded = await loadToken(id);
  assert.equal(loaded?.token, PLACEHOLDER_TOKEN);
  assert.equal(loaded?.backend, 'file');
});

test('the directory is 0700 and the file is 0600', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const id = { host: 'gerrit.example.com', user: 'ada', env: home.env };
  const store = await saveToken(PLACEHOLDER_TOKEN, id);

  const configStat = await fs.stat(path.join(home.dir, 'gerrit-axi'));
  const credStat = await fs.stat(path.join(home.dir, 'gerrit-axi', 'credentials'));
  const fileStat = await fs.stat(/** @type {string} */ (store.location));

  assert.equal(configStat.mode & 0o777, 0o700);
  assert.equal(credStat.mode & 0o777, 0o700);
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('credentials for different hosts and users do not collide', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const ada = { host: 'a.example.com', user: 'ada', env: home.env };
  const alan = { host: 'b.example.com', user: 'alan', env: home.env };

  await saveToken(`${PLACEHOLDER_TOKEN}-ada`, ada);
  await saveToken(`${PLACEHOLDER_TOKEN}-alan`, alan);

  assert.equal((await loadToken(ada))?.token, `${PLACEHOLDER_TOKEN}-ada`);
  assert.equal((await loadToken(alan))?.token, `${PLACEHOLDER_TOKEN}-alan`);

  await clearToken(ada);
  assert.equal(await loadToken(ada), null);
  assert.equal((await loadToken(alan))?.token, `${PLACEHOLDER_TOKEN}-alan`, 'the other must survive');
});

test('clearToken reports what it removed, and is a no-op when there is nothing', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const id = { host: 'gerrit.example.com', user: 'ada', env: home.env };

  assert.deepEqual(await clearToken(id), { removed: [] });
  await saveToken(PLACEHOLDER_TOKEN, id);
  assert.deepEqual(await clearToken(id), { removed: ['file'] });
  assert.equal(await loadToken(id), null);
});

test('an empty token is refused rather than stored', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  await assert.rejects(
    () => saveToken('', { host: 'gerrit.example.com', user: 'ada', env: home.env }),
    /refusing to store an empty token/,
  );
});

test('requireToken turns a missing credential into an actionable AuthError', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  await assert.rejects(
    () => requireToken({ host: 'gerrit.example.com', user: 'ada', env: home.env }),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, 'NO_CREDENTIAL');
      assert.match(err.remedy, /auth login/);
      // The message names the account but obviously cannot contain a token.
      assert.match(err.message, /ada@gerrit\.example\.com/);
      return true;
    },
  );
});

/**
 * Install a stub `secret-tool` on PATH. It records its own argv, which is how we
 * assert the token is passed on stdin and never as a command-line argument.
 *
 * @param {{dir: string, failStore?: boolean}} opts
 */
async function stubSecretTool({ dir, failStore = false }) {
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(state, { recursive: true });

  const script = [
    '#!/bin/sh',
    // The caller's PATH points only at this stub dir (so no real secret-tool can
    // be picked up); give the script itself a PATH for the utilities it uses.
    'PATH=/usr/bin:/bin; export PATH',
    `printf '%s\\n' "$*" >> "${state}/argv"`,
    'case "$1" in',
    failStore
      ? `  store) cat > /dev/null; exit 1 ;;`
      : `  store) cat > "${state}/secret"; exit 0 ;;`,
    `  lookup) if [ -s "${state}/secret" ]; then cat "${state}/secret"; exit 0; else exit 1; fi ;;`,
    `  search) if [ -s "${state}/secret" ]; then echo '[/org/freedesktop/secrets/collection/login/1]'; fi; exit 0 ;;`,
    `  clear) rm -f "${state}/secret"; exit 0 ;;`,
    'esac',
    'exit 2',
    '',
  ].join('\n');

  const file = path.join(bin, 'secret-tool');
  await fs.writeFile(file, script, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return {
    bin,
    argv: async () => {
      try {
        return await fs.readFile(path.join(state, 'argv'), 'utf8');
      } catch {
        return '';
      }
    },
    secret: async () => {
      try {
        return (await fs.readFile(path.join(state, 'secret'), 'utf8')).trim();
      } catch {
        return null;
      }
    },
  };
}

test('hasStoredToken finds a keyring item without retrieving its secret', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const stub = await stubSecretTool({ dir: home.dir });
  const env = { XDG_CONFIG_HOME: home.dir, PATH: stub.bin };
  const id = { host: 'gerrit.example.com', user: 'ada', env };

  assert.equal(await hasStoredToken(id), false);
  await saveToken(PLACEHOLDER_TOKEN, id);
  const before = await stub.argv();
  assert.equal(await hasStoredToken(id), true);
  const calls = (await stub.argv()).slice(before.length).trim().split('\n');
  assert.deepEqual(calls.map((line) => line.split(' ')[0]), ['search']);
});

test('the keyring backend is preferred when available', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const stub = await stubSecretTool({ dir: home.dir });
  const env = { XDG_CONFIG_HOME: home.dir, PATH: stub.bin };
  const id = { host: 'gerrit.example.com', user: 'ada', env };

  assert.equal(await detectBackend({ env }), 'secret-tool');

  const store = await saveToken(PLACEHOLDER_TOKEN, id);
  assert.equal(store.backend, 'secret-tool');
  assert.equal(store.encryptedAtRest, true);
  assert.equal(store.location, null);
  assert.deepEqual(store.degraded, []);

  assert.equal(await stub.secret(), PLACEHOLDER_TOKEN, 'the token arrived on stdin');
  assert.equal((await loadToken(id))?.backend, 'secret-tool');

  // Nothing was written to disk by us.
  const credDir = path.join(home.dir, 'gerrit-axi', 'credentials');
  assert.deepEqual(await fs.readdir(credDir), []);
});

test('the token is never passed in argv', async (t) => {
  // argv is world-readable via ps, which is why this is a test and not a comment.
  const home = await tempHome();
  t.after(home.cleanup);
  const stub = await stubSecretTool({ dir: home.dir });
  const env = { XDG_CONFIG_HOME: home.dir, PATH: stub.bin };
  const id = { host: 'gerrit.example.com', user: 'ada', env };

  await saveToken(PLACEHOLDER_TOKEN, id);
  await loadToken(id);
  await clearToken(id);

  const argv = await stub.argv();
  assert.ok(argv.length > 0, 'the stub should have been called');
  assert.equal(argv.includes(PLACEHOLDER_TOKEN), false, 'the token leaked into argv');
});

test('a failing keyring degrades loudly to the plaintext file', async (t) => {
  const home = await tempHome();
  t.after(home.cleanup);
  const stub = await stubSecretTool({ dir: home.dir, failStore: true });
  const env = { XDG_CONFIG_HOME: home.dir, PATH: stub.bin };
  const id = { host: 'gerrit.example.com', user: 'ada', env };

  const store = await saveToken(PLACEHOLDER_TOKEN, id);
  assert.equal(store.backend, 'file');
  assert.equal(store.encryptedAtRest, false);
  assert.deepEqual(store.degraded, ['secret-tool (keyring unavailable)'],
    'the fallback must be reported, not silent');

  // And the file backend is still readable afterwards.
  assert.equal((await loadToken(id))?.token, PLACEHOLDER_TOKEN);
});
