// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthError, TransportError } from '../src/core/errors.js';
import {
  XSSI_PREFIX,
  assertRestOk,
  basicAuthHeader,
  parseGerritJson,
  restGetJson,
  stripXssiPrefix,
  verifyToken,
} from '../src/core/rest.js';
import { PLACEHOLDER_TOKEN, fakeFetch, fixture } from './helpers.js';

test('the XSSI guard is stripped from a Gerrit body', () => {
  assert.equal(XSSI_PREFIX, ")]}'");
  assert.equal(stripXssiPrefix(")]}'\n{\"a\":1}"), '{"a":1}');
  assert.equal(stripXssiPrefix(")]}'\r\n{\"a\":1}"), '{"a":1}');
  assert.equal(stripXssiPrefix(")]}'\n[1,2,3]\n"), '[1,2,3]\n');
});

test('a body without the guard is returned untouched', () => {
  assert.equal(stripXssiPrefix('{"a":1}'), '{"a":1}');
  assert.equal(stripXssiPrefix(''), '');
  // Only a leading guard counts; the same bytes inside the payload stay put.
  assert.equal(stripXssiPrefix('{"a":")]}\'"}'), '{"a":")]}\'"}');
});

test('a guard with nothing after it yields an empty body rather than a crash', () => {
  assert.equal(stripXssiPrefix(")]}'"), '');
  assert.throws(() => parseGerritJson(")]}'", '/a/x'), TransportError);
});

test('parseGerritJson strips the guard and parses the real fixture body', () => {
  const parsed = parseGerritJson(fixture('comments-body.txt'), '/a/changes/1/comments');
  assert.ok('/PATCHSET_LEVEL' in parsed);
  assert.equal(Object.keys(parsed).length, 3);
});

test('parseGerritJson reports unparseable bodies as a transport problem', () => {
  assert.throws(
    () => parseGerritJson(")]}'\n<html>login page</html>", '/a/accounts/self'),
    (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'BAD_RESPONSE');
      assert.match(err.message, /\/a\/accounts\/self/);
      return true;
    },
  );
});

test('the credential travels as HTTP Basic, not as a bearer token', () => {
  const header = basicAuthHeader('ada', 'sekrit');
  assert.match(header, /^Basic /);
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'ada:sekrit');
});

test('401 is distinct: it means the credential is bad, and says to log in again', () => {
  assert.throws(
    () => assertRestOk(401, '/a/accounts/self', 'https://gerrit.example.com'),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.match(err.remedy, /auth login/);
      assert.match(err.remedy, /gerrit\.example\.com\/settings/);
      return true;
    },
  );
});

test('403 is distinct: authenticated but not permitted', () => {
  assert.throws(
    () => assertRestOk(403, '/a/changes/1/comments'),
    (err) => {
      assert.ok(err instanceof TransportError, '403 must not be an AuthError');
      assert.equal(err.code, 'FORBIDDEN');
      assert.match(err.message, /403/);
      return true;
    },
  );
});

test('404 is distinct: no such resource', () => {
  assert.throws(
    () => assertRestOk(404, '/a/changes/999/comments'),
    (err) => {
      assert.ok(err instanceof TransportError);
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('a redirect and a 5xx are neither of the three', () => {
  assert.throws(() => assertRestOk(302, '/a/x'), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    assert.match(err.remedy, /restBase/);
    return true;
  });
  assert.throws(() => assertRestOk(500, '/a/x'), (err) => {
    assert.equal(err.code, 'HTTP_ERROR');
    return true;
  });
});

test('2xx passes', () => {
  assert.doesNotThrow(() => assertRestOk(200, '/a/x'));
  assert.doesNotThrow(() => assertRestOk(204, '/a/x'));
});

const target = {
  restBase: 'https://gerrit.example.com',
  user: 'ada',
  token: PLACEHOLDER_TOKEN,
};

test('restGetJson sends Basic auth and never follows a redirect while carrying it', async () => {
  const fetchImpl = fakeFetch([{ path: '/a/accounts/self', body: ")]}'\n{\"_account_id\":1000}" }]);
  await restGetJson({ ...target, fetchImpl }, '/a/accounts/self');
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].headers.Authorization, /^Basic /);
  assert.equal(fetchImpl.calls[0].headers.Authorization.includes(PLACEHOLDER_TOKEN), false,
    'the token must be base64-encoded in the header, not appended raw');
});

test('verifyToken reads the account out of /a/accounts/self', async () => {
  const fetchImpl = fakeFetch([{
    path: '/a/accounts/self',
    body: ")]}'\n" + JSON.stringify({
      _account_id: 4201,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      username: 'ada',
    }),
  }]);
  const account = await verifyToken({ ...target, fetchImpl });
  assert.deepEqual(account, {
    accountId: 4201,
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    username: 'ada',
  });
});

test('verifyToken turns a rejected token into an AuthError, not a generic failure', async () => {
  const fetchImpl = fakeFetch([{ path: '/a/accounts/self', status: 401, body: 'Unauthorized' }]);
  await assert.rejects(
    () => verifyToken({ ...target, fetchImpl }),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(err.code, 'UNAUTHORIZED');
      return true;
    },
  );
});

test('no error message ever contains the token', async () => {
  const statuses = [401, 403, 404, 500, 302];
  for (const status of statuses) {
    const fetchImpl = fakeFetch([{ path: '/a/accounts/self', status, body: 'nope' }]);
    await assert.rejects(
      () => verifyToken({ ...target, fetchImpl }),
      (err) => {
        assert.equal(err.message.includes(PLACEHOLDER_TOKEN), false, `HTTP ${status} message leaked the token`);
        assert.equal((err.remedy ?? '').includes(PLACEHOLDER_TOKEN), false, `HTTP ${status} remedy leaked the token`);
        return true;
      },
    );
  }
});
