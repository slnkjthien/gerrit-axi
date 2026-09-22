// SPDX-License-Identifier: Apache-2.0

/**
 * SSH transport for `gerrit query`.
 *
 * Change queries go over SSH because that channel returns the submit records --
 * the server's own readiness verdict -- in one round trip, and because it needs
 * no HTTP credential. Only inline comments require REST.
 *
 * We always ask for `--current-patch-set --all-approvals --submit-records`; those
 * three flags are what make the readiness oracle possible. Anything beyond them
 * is opt-in per call, because it costs the server work on every row: see
 * `DETAIL_QUERY_FLAGS`.
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
 * ssh reads any argv element that begins with `-` as an option, and some of its
 * options run a local command before any connection is attempted. The user and
 * host are data -- a git remote's userinfo, the environment, a config file, the
 * local login name -- so neither may begin with one.
 *
 * `resolveConfig` calls this for every connection it resolves, which is the
 * guard; `buildSshArgs` calls it again for a library caller that hands over a
 * connection of its own. The rejected value is never echoed: it is someone
 * else's text on its way to a terminal.
 *
 * @template {{host: string, user: string}} C
 * @param {C} conn
 * @param {Record<string, string>} [sources]  which tier supplied each field
 * @returns {C} the connection, unchanged, when it is safe
 */
export function assertSafeConnection(conn, sources = {}) {
  for (const [field, noun] of /** @type {const} */ ([['user', 'username'], ['host', 'host']])) {
    if (String(conn[field]).startsWith('-')) {
      const from = sources[field] ? ` (source: ${sources[field]})` : '';
      throw new TransportError(
        `the Gerrit ${noun}${from} begins with "-", which ssh would read as an option rather than a destination`,
        {
          code: 'UNSAFE_CONNECTION',
          remedy: 'Correct the value where it came from, or pass --user / --host to override it.',
        },
      );
    }
  }
  return conn;
}

/**
 * Detail a caller may ask for on top of the three flags every query sends.
 *
 * `comments` adds the change's cover messages -- the "Patch Set 7: ...", "Build
 * Successful <url>", "Uploaded patch set 8" timeline. (Gerrit would also attach
 * per-patch-set inline comments to this flag, but only alongside `--patch-sets`,
 * which we never ask for: REST serves inline comments, and asking twice would be
 * paying for the same data on every row.)
 *
 * `dependencies` adds `dependsOn` / `neededBy`, each carrying the revision it
 * refers to and whether that revision is still that change's current patch set.
 *
 * This is an allowlist, not a passthrough: a caller names a key here, never a
 * flag string, so nothing a caller supplies can become an element of argv.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const DETAIL_QUERY_FLAGS = Object.freeze({
  comments: '--comments',
  dependencies: '--dependencies',
});

/**
 * @param {readonly string[]} include  keys of DETAIL_QUERY_FLAGS
 * @returns {string[]} the flags, deduplicated, in the order they were named
 */
function detailFlags(include) {
  /** @type {string[]} */
  const flags = [];
  for (const name of include) {
    const flag = Object.prototype.hasOwnProperty.call(DETAIL_QUERY_FLAGS, name)
      ? DETAIL_QUERY_FLAGS[name]
      : undefined;
    if (!flag) {
      throw new TransportError(`unknown query detail: ${name}`, {
        code: 'UNSAFE_QUERY',
        remedy: `known details: ${Object.keys(DETAIL_QUERY_FLAGS).join(', ')}`,
      });
    }
    if (!flags.includes(flag)) flags.push(flag);
  }
  return flags;
}

/**
 * Build the argv for `ssh`. Exported so tests can assert on it without running
 * anything. No credential is ever an element of this array -- SSH authenticates
 * with the user's own agent/keys.
 *
 * @param {{host: string, port: number, user: string}} conn
 * @param {string} query
 * @param {{limit?: number, connectTimeoutSeconds?: number, include?: readonly string[]}} [opts]
 * @returns {string[]}
 */
export function buildSshArgs(
  conn,
  query,
  { limit = 100, connectTimeoutSeconds = 10, include = [] } = {},
) {
  assertSafeConnection(conn);
  assertSafeQuery(query);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TransportError(`invalid limit: ${limit}`, { code: 'UNSAFE_QUERY' });
  }
  return [
    '-p', String(conn.port),
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSeconds}`,
    // Past this marker ssh parses no option, so the destination is never one.
    '--',
    `${conn.user}@${conn.host}`,
    'gerrit', 'query',
    '--format=JSON',
    '--current-patch-set',
    '--all-approvals',
    '--submit-records',
    ...detailFlags(include),
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
 * @param {{limit?: number, runner?: import('./exec.js').Runner,
 *          include?: readonly string[]}} [opts]
 * @returns {Promise<{rows: any[], stats: any|null}>}
 */
export async function sshQuery(
  conn,
  query,
  { limit = 100, runner = runCommand, include = [] } = {},
) {
  const args = buildSshArgs(conn, query, { limit, include });
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
      `ssh to Gerrit failed: ${firstLine(result.stderr) || `exit ${result.code}`}`,
      {
        code: 'SSH_FAILED',
        remedy: [
          'Check that your SSH key is registered with Gerrit and that the host is reachable:',
          `    ssh -p ${conn.port} -- <user>@<host> gerrit version`,
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
