// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { deriveReadiness, deriveVotes, normalizeChange, buildQuery } from '../src/core/changes.js';
import { parseQueryOutput } from '../src/core/ssh.js';
import { SRC_DIR, fixture, fixtureJson } from './helpers.js';

const scenarios = fixtureJson('submit-records.json');

test('a NEED label is what is blocking the change', () => {
  const readiness = deriveReadiness(scenarios.singleRecordBlocked);
  assert.equal(readiness.status, 'NOT_READY');
  assert.equal(readiness.submittable, false);
  assert.deepEqual(readiness.blocking, ['Xylophone-Gate']);
  // MAY is advisory: present in the enumeration, absent from the blockers.
  assert.deepEqual(
    readiness.labels.map((l) => [l.name, l.status, l.blocking]),
    [
      ['Quokka-Review', 'OK', false],
      ['Xylophone-Gate', 'NEED', true],
      ['Yak-Shave', 'MAY', false],
    ],
  );
});

test('a REJECT label blocks as well as a NEED', () => {
  const readiness = deriveReadiness(scenarios.singleRecordRejected);
  assert.deepEqual(readiness.blocking, ['Quokka-Review']);
  assert.equal(readiness.submittable, false);
});

test('an OK record is submittable with nothing blocking', () => {
  const readiness = deriveReadiness(scenarios.submittable);
  assert.equal(readiness.status, 'OK');
  assert.equal(readiness.submittable, true);
  assert.deepEqual(readiness.blocking, []);
});

test('with several submit records, the worst status per label wins', () => {
  const readiness = deriveReadiness(scenarios.twoRecordsWorstWins);
  assert.equal(readiness.recordCount, 2);
  assert.equal(readiness.status, 'NOT_READY', 'OK only when every record says OK');
  const quokka = readiness.labels.find((l) => l.name === 'Quokka-Review');
  assert.equal(quokka?.status, 'REJECT', 'the OK from the first record must not mask the REJECT');
  assert.deepEqual(readiness.blocking.sort(), ['Quokka-Review', 'Zebu-Herding']);
});

test('IMPOSSIBLE blocks', () => {
  const readiness = deriveReadiness(scenarios.impossible);
  assert.deepEqual(readiness.blocking, ['Nonexistent-Label']);
});

test('a rule error is surfaced with the server\'s message', () => {
  const readiness = deriveReadiness(scenarios.ruleError);
  assert.equal(readiness.status, 'RULE_ERROR');
  assert.equal(readiness.submittable, false);
  assert.match(readiness.errorMessage ?? '', /submit rule threw/);
});

test('a closed change reports the server\'s CLOSED status verbatim', () => {
  const readiness = deriveReadiness(scenarios.closed);
  assert.equal(readiness.status, 'CLOSED');
  assert.equal(readiness.submittable, false);
});

test('no submit record means UNKNOWN, not "ready"', () => {
  const readiness = deriveReadiness(scenarios.noRecords);
  assert.equal(readiness.status, 'UNKNOWN');
  assert.equal(readiness.submittable, false);
  assert.deepEqual(readiness.labels, []);
  assert.deepEqual(readiness.blocking, []);
  assert.equal(readiness.recordCount, 0);
});

test('a label status we have never seen is enumerated but not claimed as blocking', () => {
  const readiness = deriveReadiness(scenarios.unknownLabelStatus);
  assert.deepEqual(readiness.labels.map((l) => l.name), ['Future-Status-Label']);
  assert.equal(readiness.labels[0].status, 'SOMETHING_NEW');
  assert.equal(readiness.labels[0].blocking, false);
  assert.equal(readiness.status, 'NOT_READY', 'the overall verdict still shows it is not ready');
});

test('readiness enumerates whatever labels the server reports, with no built-in list', () => {
  const { rows } = parseQueryOutput(fixture('query-output.txt'));
  const changes = rows.map(normalizeChange);

  const names = new Set(changes.flatMap((c) => c.readiness.labels.map((l) => l.name)));
  assert.deepEqual([...names].sort(), ['Release-Gate', 'Widget-Approval', 'Zebra-Check']);

  const blocked = changes.find((c) => c.number === 184458);
  assert.deepEqual(blocked?.readiness.blocking, ['Zebra-Check']);

  const ready = changes.find((c) => c.number === 184431);
  assert.equal(ready?.readiness.submittable, true);
});

test('src/core contains no hardcoded label names', () => {
  // The whole point of the submit-record oracle: label names are one site's
  // configuration. If any appears in core's *code*, the tool has stopped being
  // portable. Prose is exempt -- the modules name these three as examples of
  // exactly what must not be hardcoded, which is worth saying out loud.
  const forbidden = [/\bVerified\b/, /\bCode-Review\b/, /\bAI-review\b/i];
  for (const file of ['changes.js', 'comments.js', 'config.js', 'rest.js', 'ssh.js', 'severity.js']) {
    const code = stripComments(readFileSync(path.join(SRC_DIR, 'core', file), 'utf8'));
    for (const pattern of forbidden) {
      assert.equal(pattern.test(code), false, `${file} must not mention ${pattern} in code`);
    }
  }
});

/**
 * Remove block comments and whole-line `//` comments. Inline code is left alone,
 * so a label name smuggled into a string literal is still caught.
 *
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

test('votes are grouped under whatever label names the server used', () => {
  const votes = deriveVotes({
    currentPatchSet: {
      approvals: [
        { type: 'Quokka-Review', value: '2', by: { username: 'grace' } },
        { type: 'Quokka-Review', value: '-1', by: { username: 'alan' } },
        { type: 'Xylophone-Gate', value: '1', by: { username: 'buildbot' } },
      ],
    },
  });
  assert.deepEqual(votes.map((v) => v.name), ['Quokka-Review', 'Xylophone-Gate']);
  assert.equal(votes[0].max, 2);
  assert.equal(votes[0].min, -1);
  assert.equal(votes[0].votes.length, 2);
});

test('votes are absent, not invented, when the server sends none', () => {
  assert.deepEqual(deriveVotes({}), []);
  assert.deepEqual(deriveVotes({ currentPatchSet: {} }), []);
});

test('normalizeChange turns epoch seconds into dates and coerces numeric fields', () => {
  const { rows } = parseQueryOutput(fixture('query-output.txt'));
  const change = normalizeChange(rows[0]);
  assert.equal(change.number, 184458);
  assert.equal(change.project, 'acme/apps/widget-console');
  assert.equal(change.branch, 'main');
  assert.equal(change.topic, 'attention-set');
  assert.equal(change.currentPatchSet?.number, 3);
  assert.ok(change.lastUpdated instanceof Date);
  assert.equal(change.lastUpdated.toISOString().slice(0, 10), '2025-07-30');
  assert.equal(change.wip, false);
  assert.equal(normalizeChange(rows[2]).wip, true);
});

test('buildQuery maps intents onto Gerrit query syntax', () => {
  assert.equal(buildQuery({ kind: 'attention' }), 'attention:self status:open');
  assert.equal(buildQuery({ kind: 'mine' }), 'owner:self status:open');
  assert.equal(buildQuery({ kind: 'changes', numbers: [184458] }), 'change:184458');
  assert.equal(
    buildQuery({ kind: 'changes', numbers: ['184458', '184431'] }),
    '(change:184458 OR change:184431)',
    'parenthesised so a trailing limit: does not bind to the last OR term',
  );
  assert.equal(buildQuery({ kind: 'raw', query: '  status:open owner:ada  ' }), 'status:open owner:ada');
  assert.throws(() => buildQuery({ kind: 'changes', numbers: ['not-a-number'] }), /not a change number/);
  assert.throws(() => buildQuery({ kind: 'changes', numbers: [] }), /no change numbers/);
});
