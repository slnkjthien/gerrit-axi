import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSeverityPatterns, resolveConfig } from '../src/core/config.js';
import { annotateSeverity, classifySeverity, compileSeverityPatterns } from '../src/core/severity.js';
import { listComments, normalizeComments } from '../src/core/comments.js';
import { parseGerritJson } from '../src/core/rest.js';
import { Session } from '../src/core/session.js';
import { PLACEHOLDER_TOKEN, fakeFetch, fixture } from './helpers.js';

const body = fixture('comments-body.txt');
const comments = normalizeComments(parseGerritJson(body));

/**
 * A concrete instance of the convention: it belongs to one organisation's CI
 * job, so here it is test data, not product behaviour.
 */
const SITE_PATTERNS = [
  { name: 'issue', pattern: '^\\s*\\[issue\\]', flags: 'i' },
  { name: 'suggestion', pattern: '^\\s*\\[suggestion\\]', flags: 'i' },
];

test('an empty pattern list is a strict no-op', () => {
  assert.equal(classifySeverity('[issue] Possible null dereference', []), null);
  assert.equal(classifySeverity('[suggestion] extract a constant', []), null);
  assert.equal(classifySeverity('anything at all', []), null);
  assert.deepEqual(compileSeverityPatterns([]), []);
  assert.deepEqual(compileSeverityPatterns(), []);
});

test('annotateSeverity with no patterns changes nothing but adds severity: null', () => {
  const annotated = annotateSeverity(comments, []);
  assert.equal(annotated.length, comments.length);
  assert.ok(annotated.every((c) => c.severity === null));
  for (const [i, c] of annotated.entries()) {
    const { severity, ...rest } = c;
    assert.deepEqual(rest, comments[i], 'no other field may be touched');
  }
});

test('configured patterns classify the comments that match them', () => {
  const compiled = compileSeverityPatterns(SITE_PATTERNS);
  assert.equal(classifySeverity('[issue] Possible null dereference', compiled), 'issue');
  assert.equal(classifySeverity('[suggestion] extract a constant', compiled), 'suggestion');
  assert.equal(classifySeverity('  [ISSUE] case-insensitive by default', compiled), 'issue');
  assert.equal(classifySeverity('Is this reachable?', compiled), null, 'unmatched stays unclassified');
});

test('the first matching pattern wins, so config order is precedence order', () => {
  const patterns = [
    { name: 'first', pattern: 'widget' },
    { name: 'second', pattern: 'widget' },
  ];
  assert.equal(classifySeverity('the widget', compileSeverityPatterns(patterns)), 'first');
  assert.equal(
    classifySeverity('the widget', compileSeverityPatterns([...patterns].reverse())),
    'second',
  );
});

test('classification is applied over the real comment set', () => {
  const annotated = annotateSeverity(comments, SITE_PATTERNS);
  assert.deepEqual(
    annotated.map((c) => [c.id, c.severity]),
    [
      ['psl0001', null],
      ['cmt0001', null],
      ['cmt0002', 'issue'],
      ['cmt0003', 'suggestion'],
      ['cmt0004', null],
    ],
  );
});

test('a global regexp does not carry lastIndex between comments', () => {
  const compiled = compileSeverityPatterns([{ name: 'note', pattern: 'note', flags: 'gi' }]);
  assert.equal(classifySeverity('note one', compiled), 'note');
  assert.equal(classifySeverity('note two', compiled), 'note', 'second call must still match');
});

test('listComments applies the session\'s configured patterns', async () => {
  const fetchImpl = fakeFetch([{ path: '/comments', body }]);
  const session = new Session({
    config: {
      host: 'gerrit.example.com',
      port: 29418,
      user: 'ada',
      project: null,
      restBase: 'https://gerrit.example.com',
      severityPatterns: SITE_PATTERNS,
      sources: {},
      configPath: '/nonexistent/config.json',
    },
    env: {},
    fetchImpl,
  });
  session.rememberToken(PLACEHOLDER_TOKEN);

  const result = await listComments(session, 184458);
  assert.deepEqual(
    result.filter((c) => c.severity).map((c) => c.severity),
    ['issue', 'suggestion'],
  );
});

test('severity defaults to empty when the config file says nothing', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'gerrit.example.com', GERRIT_USER: 'ada' },
    remoteUrl: null,
    readFile: async () => JSON.stringify({ host: 'gerrit.example.com' }),
  });
  assert.deepEqual(config.severityPatterns, []);
});

test('severity.patterns is read from the config file', async () => {
  const config = await resolveConfig({}, {
    env: { XDG_CONFIG_HOME: '/nonexistent', GERRIT_HOST: 'gerrit.example.com', GERRIT_USER: 'ada' },
    remoteUrl: null,
    readFile: async () => JSON.stringify({ severity: { patterns: SITE_PATTERNS } }),
  });
  assert.deepEqual(config.severityPatterns, [
    { name: 'issue', pattern: '^\\s*\\[issue\\]', flags: 'i' },
    { name: 'suggestion', pattern: '^\\s*\\[suggestion\\]', flags: 'i' },
  ]);
});

test('flags default to case-insensitive when omitted', () => {
  const [pattern] = normalizeSeverityPatterns({ patterns: [{ name: 'issue', pattern: 'x' }] });
  assert.equal(pattern.flags, 'i');
});

test('a bare array is accepted as well as { patterns: [...] }', () => {
  assert.deepEqual(
    normalizeSeverityPatterns([{ name: 'issue', pattern: 'x' }]),
    [{ name: 'issue', pattern: 'x', flags: 'i' }],
  );
});

test('a broken severity config fails at config time, not mid-result-set', () => {
  assert.throws(() => normalizeSeverityPatterns({ patterns: 'nope' }), /must be an array/);
  assert.throws(() => normalizeSeverityPatterns({ patterns: [{ pattern: 'x' }] }), /name must be/);
  assert.throws(() => normalizeSeverityPatterns({ patterns: [{ name: 'x' }] }), /pattern must be/);
  assert.throws(
    () => normalizeSeverityPatterns({ patterns: [{ name: 'x', pattern: '[unclosed' }] }),
    /not a valid regular expression/,
  );
  assert.throws(
    () => normalizeSeverityPatterns({ patterns: [{ name: 'x', pattern: 'y', flags: 'zzz' }] }),
    /not a valid regular expression/,
  );
});

test('absent severity config normalizes to an empty list', () => {
  assert.deepEqual(normalizeSeverityPatterns(undefined), []);
  assert.deepEqual(normalizeSeverityPatterns(null), []);
  assert.deepEqual(normalizeSeverityPatterns({}), []);
});
