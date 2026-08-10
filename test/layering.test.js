// SPDX-License-Identifier: Apache-2.0

/**
 * Guards on the two architectural rules. These are the tests that fail if a later
 * change quietly dissolves the layering, which is the failure mode worth catching
 * mechanically rather than in review.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SRC_DIR } from './helpers.js';

const REPO_ROOT = path.join(SRC_DIR, '..');

/**
 * @param {string} dir
 * @returns {string[]}
 */
function jsFilesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const coreFiles = jsFilesUnder(path.join(SRC_DIR, 'core'));

test('src/core does not print anything', () => {
  // Rule 1: the moment core knows what a table looks like, the layering is gone.
  assert.ok(coreFiles.length >= 8, 'expected core to have modules to check');
  for (const file of coreFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\bconsole\s*\./.test(code), false, `${path.basename(file)} must not use console`);
    assert.equal(/process\.stdout\b/.test(code), false, `${path.basename(file)} must not write to stdout`);
    assert.equal(/process\.stderr\b/.test(code), false, `${path.basename(file)} must not write to stderr`);
  }
});

test('src/core does not import anything from src/cli', () => {
  for (const file of coreFiles) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/from\s+['"][^'"]*\/cli\//.test(text), false,
      `${path.basename(file)} must not depend on the presentation layer`);
  }
});

test('src/core contains no rendering vocabulary', () => {
  // A weak proxy, but it catches the obvious regressions: colour codes and
  // column padding leaking into the data layer.
  for (const file of coreFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/\\u001b\[/.test(code), false, `${path.basename(file)} must not emit ANSI escapes`);
    assert.equal(/\bpadEnd\b|\bpadStart\b/.test(code), false,
      `${path.basename(file)} must not pad columns`);
  }
});

test('there is no hardcoded hostname anywhere in the codebase', () => {
  // Tier 2's central promise. `example.com` and friends are RFC 2606 reserved
  // documentation names and are allowed in usage text.
  const allowedHosts = /^(?:[a-z0-9-]+\.)?example\.(?:com|org|net)$/;
  const hostLike = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|internal|local|corp|lan|intranet)\b/gi;

  const files = [
    ...jsFilesUnder(SRC_DIR),
    path.join(REPO_ROOT, 'bin', 'gerrit.js'),
  ];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const match of code.match(hostLike) ?? []) {
      assert.ok(
        allowedHosts.test(match.toLowerCase()),
        `${path.relative(REPO_ROOT, file)} contains a hostname literal: ${match}`,
      );
    }
  }
});

test('no hardcoded project-path prefix', () => {
  // Path shortening is derived from the result set. A constant listing one
  // server's top-level project directories -- `/^(one|two)\//` and friends --
  // is wrong on every other server, so it must not appear.
  const prefixLiteral = /\^?\(\s*[a-z0-9][a-z0-9._-]*\s*(?:\|\s*[a-z0-9][a-z0-9._-]*\s*)+\)\s*\\?\//;
  const files = [...jsFilesUnder(SRC_DIR), path.join(REPO_ROOT, 'bin', 'gerrit.js')];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(prefixLiteral.test(code), false,
      `${path.relative(REPO_ROOT, file)} must not hardcode a project-path prefix`);
  }
});

test('src/axi does not exist yet', () => {
  // Explicitly out of scope for v0.1, and its absence is part of the contract.
  assert.equal(existsSync(path.join(SRC_DIR, 'axi')), false);
});

test('the package has no runtime dependencies and does not depend on axi-sdk-js', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(JSON.stringify(pkg).includes('axi-sdk-js'), false);
});

test('the core entry point exposes the library API a second binary would import', async () => {
  const core = await import('../src/core/index.js');
  for (const name of [
    'createSession',
    'Session',
    'resolveConfig',
    'queryChanges',
    'listComments',
    'deriveReadiness',
    'authStatus',
    'loginWithToken',
    'logout',
    'GerritError',
  ]) {
    assert.equal(typeof core[name] !== 'undefined', true, `core must export ${name}`);
  }
  // ...and nothing that renders.
  for (const name of ['table', 'makeColorizer', 'runStatus', 'main']) {
    assert.equal(name in core, false, `core must not export the presentation helper ${name}`);
  }
});

test('v0.1 is read-only: no mutating Gerrit call appears in the codebase', () => {
  const files = [...jsFilesUnder(SRC_DIR), path.join(REPO_ROOT, 'bin', 'gerrit.js')];
  const mutations = [
    /\bmethod:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/i,
    /gerrit\s+review\b/,
    /gerrit\s+set-reviewers\b/,
    /gerrit\s+set-topic\b/,
    /\bgit\s+push\b/,
  ];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const pattern of mutations) {
      assert.equal(pattern.test(code), false,
        `${path.relative(REPO_ROOT, file)} looks like it mutates Gerrit: ${pattern}`);
    }
  }
});
