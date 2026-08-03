/**
 * Subprocess helpers.
 *
 * Rule inherited from the spike: credentials never appear in argv, because argv
 * is world-readable via `ps`. Anything secret is written to the child's stdin.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} RunResult
 * @property {number|null} code   exit status, or null if killed by a signal
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @typedef {(file: string, args: string[], opts?: {input?: string, timeoutMs?: number,
 *            env?: NodeJS.ProcessEnv}) => Promise<RunResult>} Runner
 */

/**
 * Run a command, capturing stdout/stderr. Never rejects on a non-zero exit --
 * callers inspect `code` -- but does reject if the binary cannot be spawned.
 *
 * `env` must be the same environment used to probe for the binary with
 * `commandExists`, or the two disagree about which PATH is in effect.
 *
 * @type {Runner}
 */
export function runCommand(file, args, { input, timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr: timedOut ? `${stderr}\ntimed out after ${timeoutMs}ms` : stderr,
      });
    });

    // stdin is the only channel a secret may travel on.
    child.stdin.on('error', () => { /* child may exit before reading stdin */ });
    child.stdin.end(input ?? '');
  });
}

/**
 * Is an executable on PATH? Resolved without spawning anything, so probing for
 * optional backends (secret-tool, gpg) costs nothing.
 *
 * @param {string} file
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function commandExists(file, env = process.env) {
  if (file.includes(path.sep)) {
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      accessSync(path.join(dir, file), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}
