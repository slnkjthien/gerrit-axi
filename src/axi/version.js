// SPDX-License-Identifier: Apache-2.0

/**
 * The version, and the fast path that answers a bare version probe.
 *
 * A leaf on purpose: it imports node builtins and nothing else, so
 * bin/gerrit-axi.js can answer `--version` before the command graph (core, the
 * transports, the renderers) is loaded at all. Importing anything from src/
 * here would pull that graph back in and the fast path would buy nothing.
 */

import { readFileSync } from 'node:fs';

/** @type {string} */
export const VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/** Every spelling of the version flag; each prints the bare version. */
export const VERSION_FLAGS = /** @type {const} */ (['-v', '-V', '--version']);

/**
 * Answer a version probe that is the whole argv. Anything else -- a version
 * flag after a command, or among other options -- returns false having written
 * nothing, and main() in src/axi/main.js answers it with the same output.
 *
 * @param {readonly string[]} argv
 * @param {{write: (chunk: string) => unknown}} [stdout]
 * @returns {boolean} whether the version was written
 */
export function tryFastPath(argv, stdout = process.stdout) {
  if (argv.length !== 1 || !VERSION_FLAGS.includes(/** @type {any} */ (argv[0]))) return false;
  stdout.write(`${VERSION}\n`);
  return true;
}
