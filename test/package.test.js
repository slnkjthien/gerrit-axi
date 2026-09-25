// SPDX-License-Identifier: Apache-2.0

/**
 * The README ships inside the release tarball, so every file it links to must
 * ship too. This asks npm itself what it would pack, rather than reading the
 * `files` list, so it answers for the tarball a user actually installs.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SRC_DIR } from './helpers.js';

const REPO_ROOT = path.join(SRC_DIR, '..');

test('every relative link in the packed README resolves inside the tarball', () => {
  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [manifest] = Object.values(JSON.parse(pack.stdout));
  const packed = new Set(manifest.files.map((/** @type {{path: string}} */ f) => f.path));
  assert.ok(packed.has('README.md'), 'the README is packed');

  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1].split('#')[0])
    .filter((t) => t !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(t));
  assert.ok(targets.length > 0, 'the README links to other files');
  for (const target of targets) {
    assert.ok(packed.has(path.posix.normalize(target)), `README links to ${target}, which is not packed`);
  }
});
