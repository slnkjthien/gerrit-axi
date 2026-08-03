#!/usr/bin/env node
/**
 * The `gerrit` binary. Deliberately thin: everything it does lives in
 * src/cli/main.js, which is importable and testable without spawning a process.
 */

import { main } from '../src/cli/main.js';

process.exitCode = await main(process.argv.slice(2));
