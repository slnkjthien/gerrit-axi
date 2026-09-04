// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing for the agent tier.
 *
 * Separate from the human CLI's parser rather than shared: this tier must not
 * import `src/cli/`, and its surface is different anyway -- there is no `--no-color`
 * because nothing here is coloured, and there is a `--json` because machine
 * output is what this binary is for. An unknown option is an error rather than a
 * positional, so a caller that misspells a flag hears about it instead of getting
 * a silently different query.
 */

import { UsageError } from './output.js';

/** Applies to every subcommand; overrides every config tier. */
const GLOBAL_WITH_VALUE = new Set(['--host', '--user', '--port', '--project', '--rest-base']);
const GLOBAL_BOOLEAN = new Set(['--json', '--help', '-h', '--version', '-V']);

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} positional
 * @property {Record<string, string|boolean>} flags
 * @property {{host?: string, user?: string, port?: string, project?: string, restBase?: string}} overrides
 * @property {boolean} json
 * @property {boolean} help
 * @property {boolean} version
 */

/**
 * @param {string[]} argv
 * @param {{withValue?: Set<string>, boolean?: Set<string>}} [spec]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, spec = {}) {
  const withValue = new Set([...GLOBAL_WITH_VALUE, ...(spec.withValue ?? [])]);
  const booleans = new Set([...GLOBAL_BOOLEAN, ...(spec.boolean ?? [])]);

  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  let onlyPositional = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (onlyPositional || !arg.startsWith('-') || arg === '-') {
      positional.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositional = true;
      continue;
    }

    const eq = arg.indexOf('=');
    if (eq > 2) {
      const name = arg.slice(0, eq);
      if (!withValue.has(name)) throw new UsageError(`${name} does not take a value`);
      flags[name] = arg.slice(eq + 1);
      continue;
    }
    if (withValue.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith('-') && value !== '-')) {
        throw new UsageError(`${arg} needs a value`);
      }
      flags[arg] = value;
      i += 1;
      continue;
    }
    if (booleans.has(arg)) {
      flags[arg] = true;
      continue;
    }
    throw new UsageError(`unknown option: ${arg}`);
  }

  return {
    positional,
    flags,
    overrides: pruned({
      host: str(flags['--host']),
      user: str(flags['--user']),
      port: str(flags['--port']),
      project: str(flags['--project']),
      restBase: str(flags['--rest-base']),
    }),
    json: flags['--json'] === true,
    help: flags['--help'] === true || flags['-h'] === true,
    version: flags['--version'] === true || flags['-V'] === true,
  };
}

/**
 * Change numbers, validated here so a bad one is a usage error with the offending
 * token in it rather than a query the server refuses.
 *
 * @param {readonly string[]} positional
 * @returns {number[]}
 */
export function changeNumbers(positional) {
  return positional.map((token) => {
    if (!/^[0-9]+$/.test(token)) throw new UsageError(`not a change number: ${token}`);
    return Number(token);
  });
}

/**
 * @param {string|boolean|undefined} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
export function positiveInt(value, fallback, name) {
  if (typeof value !== 'string') return fallback;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`${name} needs a whole number, got: ${value}`);
  return Number(value);
}

/**
 * `--messages all` means every one; a number means the newest that many.
 *
 * @param {string|boolean|undefined} value
 * @returns {number}
 */
export function messageCount(value) {
  if (typeof value !== 'string') return 0;
  if (value === 'all') return Infinity;
  if (!/^[0-9]+$/.test(value)) {
    throw new UsageError(`--messages needs a whole number or 'all', got: ${value}`);
  }
  return Number(value);
}

/**
 * @template {Record<string, unknown>} T
 * @param {T} obj
 * @returns {T}
 */
function pruned(obj) {
  return /** @type {T} */ (
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
  );
}

/**
 * @param {string|boolean|undefined} value
 * @returns {string|undefined}
 */
function str(value) {
  return typeof value === 'string' ? value : undefined;
}
