/**
 * SSH transport for `gerrit query`.
 *
 * Change queries go over SSH because that channel returns the submit records --
 * the server's own readiness verdict -- in one round trip, and because it needs
 * no HTTP credential. Only inline comments require REST.
 *
 * We always ask for `--current-patch-set --all-approvals --submit-records`, as
 * the spike does; those three flags are what make the readiness oracle possible.
 *
 * Gerrit's SSH daemon parses the remote command itself; there is no shell on the
 * far side. But `host` and `port` are data read off a git remote, so a query is
 * not guaranteed to arrive at Gerrit -- point the tool at a real sshd and the
 * remote command *would* hit a shell. `assertSafeQuery` therefore rejects shell
 * metacharacters, none of which Gerrit's query language needs.
 */

import { TransportError } from './errors.js';
import { runCommand } from './exec.js';

/**
 * Characters a Gerrit query never needs, and a shell would act on. Quotes are
 * deliberately allowed: Gerrit's own tokenizer needs them for phrase operands
 * like `message:"..."`, and without command separators or expansion characters a
 * stray quote can only mangle an argument, not introduce a command.
 */
const SHELL_METACHARACTERS = /[;&|`$<>\\\n\r\0]/;

/**
 * @param {string} query
 * @returns {string} the query, unchanged, when it is safe
 */
export function assertSafeQuery(query) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TransportError('empty Gerrit query', { code: 'UNSAFE_QUERY' });
  }
  const bad = SHELL_METACHARACTERS.exec(query);
  if (bad) {
    throw new TransportError(
      `query contains a character that is not valid in a Gerrit query: ${JSON.stringify(bad[0])}`,
      {
        code: 'UNSAFE_QUERY',
        remedy: 'Gerrit query syntax needs none of  ;  &  |  `  $  <  >  \\',
      },
    );
  }
  return query;
}

/**
 * Build the argv for `ssh`. Exported so tests can assert on it without running
 * anything. No credential is ever an element of this array -- SSH authenticates
 * with the user's own agent/keys.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {string} query
 * @param {{limit?: number, connectTimeoutSeconds?: number}} [opts]
 * @returns {string[]}
 */
export function buildSshArgs(conn, query, { limit = 100, connectTimeoutSeconds = 10 } = {}) {
  assertSafeQuery(query);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TransportError(`invalid limit: ${limit}`, { code: 'UNSAFE_QUERY' });
  }
  return [
    '-p', String(conn.port),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    `${conn.user}@${conn.host}`,
    'gerrit', 'query',
    '--format=JSON',
    '--current-patch-set',
    '--all-approvals',
    '--submit-records',
    query,
    `limit:${limit}`,
  ];
}

/**
 * Parse `gerrit query --format=JSON` output: one JSON object per line, with a
 * trailing `{"type":"stats"}` row. Rows of type `error` are the server telling us
 * the query was bad, which is worth surfacing rather than returning nothing.
 *
 * @param {string} stdout
 * @returns {{rows: any[], stats: any|null}}
 */
export function parseQueryOutput(stdout) {
  /** @type {any[]} */
  const rows = [];
  /** @type {any|null} */
  let stats = null;

  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new TransportError('gerrit query returned a line that is not JSON', {
        code: 'BAD_RESPONSE',
        cause: err,
      });
    }
    if (obj?.type === 'stats') {
      stats = obj;
      continue;
    }
    if (obj?.type === 'error') {
      throw new TransportError(`gerrit rejected the query: ${obj.message ?? 'unknown error'}`, {
        code: 'GERRIT_ERROR',
      });
    }
    rows.push(obj);
  }
  return { rows, stats };
}

/**
 * Run `gerrit query` over SSH and return the raw change rows.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {string} query
 * @param {{limit?: number, runner?: import('./exec.js').Runner}} [opts]
 * @returns {Promise<{rows: any[], stats: any|null}>}
 */
export async function sshQuery(conn, query, { limit = 100, runner = runCommand } = {}) {
  const args = buildSshArgs(conn, query, { limit });
  let result;
  try {
    result = await runner('ssh', args, { timeoutMs: 60_000 });
  } catch (err) {
    throw new TransportError('could not run ssh', {
      code: 'SSH_FAILED',
      remedy: 'Is the OpenSSH client installed and on PATH?',
      cause: err,
    });
  }
  if (result.code !== 0) {
    throw new TransportError(
      `ssh to ${conn.user}@${conn.host}:${conn.port} failed: ${firstLine(result.stderr) || `exit ${result.code}`}`,
      {
        code: 'SSH_FAILED',
        remedy: [
          'Check that your SSH key is registered with Gerrit and that the host is reachable:',
          `    ssh -p ${conn.port} ${conn.user}@${conn.host} gerrit version`,
        ].join('\n'),
      },
    );
  }
  return parseQueryOutput(result.stdout);
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}
