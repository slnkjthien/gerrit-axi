#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * The `gerrit-axi` binary: the agent-facing tier. Thin like its sibling --
 * everything it does lives in src/axi/main.js, which imports src/core/ directly
 * rather than running the human `gerrit` and reading its tables.
 */

import { main } from '../src/axi/main.js';

process.exitCode = await main(process.argv.slice(2));
