#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The `gerrit-axi` binary: the agent-facing tier. Thin like its sibling --
 * everything it does lives in src/axi/main.js, which imports src/core/ directly
 * rather than running the human `gerrit` and reading its tables.
 *
 * A bare version probe is answered from a leaf module before main.js is
 * imported, so it never pays for loading the command graph.
 */

import { tryFastPath } from '../src/axi/version.js';

const argv = process.argv.slice(2);
if (!tryFastPath(argv)) {
  const { main } = await import('../src/axi/main.js');
  process.exitCode = await main(argv);
}
