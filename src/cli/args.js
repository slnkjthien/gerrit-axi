// SPDX-License-Identifier: Apache-2.0

/**
 * Argument parsing.
 *
 * Hand-rolled rather than pulled from npm: the surface is small, and the package
 * has no runtime dependencies at all.
 */

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Flags that apply to every command; they override all config tiers. */
const GLOBAL_WITH_VALUE = new Set(['--host', '--user', '--port', '--project', '--rest-base']);
const GLOBAL_BOOLEAN = new Set(['--no-color', '--help', '-h', '--version', '-V']);

/**
 * @typedef {Object} ParsedArgs
 * @property {string[]} positional
 * @property {Record<string, string|boolean>} flags
 * @property {{host?: string, user?: string, port?: string, project?: string, restBase?: string}} overrides
 * @property {boolean} help
 * @property {boolean} version
 * @property {boolean} noColor
 */

/**
 * Split argv into positional arguments, command flags, and config overrides.
 *
 * @param {string[]} argv
 * @param {{withValue?: Set<string>, boolean?: Set<string>}} [spec] command-specific flags
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

    // --flag=value
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
      host: strOrUndef(flags['--host']),
      user: strOrUndef(flags['--user']),
      port: strOrUndef(flags['--port']),
      project: strOrUndef(flags['--project']),
      restBase: strOrUndef(flags['--rest-base']),
    }),
    help: flags['--help'] === true || flags['-h'] === true,
    version: flags['--version'] === true || flags['-V'] === true,
    noColor: flags['--no-color'] === true,
  };
}

/**
 * @param {string|boolean|undefined} value
 * @returns {string|undefined}
 */
function strOrUndef(value) {
  return typeof value === 'string' ? value : undefined;
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
