// SPDX-License-Identifier: Apache-2.0

/**
 * Interactive prompts.
 *
 * `auth login` must never hang. There are exactly two ways a token can arrive:
 * a hidden prompt on a real TTY, or `--stdin`. With neither, we fail immediately
 * with instructions rather than blocking on a prompt nobody can answer.
 *
 * The prompt writes to stderr so that stdout stays clean for piping, and it never
 * echoes the typed characters.
 */

import { GerritError } from '../core/errors.js';

const ETX = '\u0003'; // Ctrl-C
const EOT = '\u0004'; // Ctrl-D
const DEL = '\u007f'; // Backspace, on most terminals

/**
 * Read a line without echoing it.
 *
 * @param {string} promptText
 * @param {{stdin?: NodeJS.ReadStream, stderr?: NodeJS.WriteStream}} [io]
 * @returns {Promise<string>}
 */
export function readSecret(promptText, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new GerritError('no interactive terminal available', { code: 'NO_TTY' });
  }
  stderr.write(promptText);

  return new Promise((resolve, reject) => {
    let buffer = '';
    const wasRaw = stdin.isRaw;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };

    /** @param {Buffer|string} chunk */
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        switch (ch) {
          case '\r':
          case '\n':
          case EOT:
            cleanup();
            stderr.write('\n');
            resolve(buffer);
            return;
          case ETX:
            cleanup();
            stderr.write('\n');
            reject(new GerritError('cancelled', { code: 'EMPTY_TOKEN' }));
            return;
          case DEL:
          case '\b':
            buffer = buffer.slice(0, -1);
            break;
          default:
            // Ignore other control characters rather than storing them.
            if (ch >= ' ') buffer += ch;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

/**
 * Read a secret from piped stdin (`--stdin`). Takes the first line only, so a
 * trailing newline from `printf`/`echo` is harmless.
 *
 * @param {{stdin?: NodeJS.ReadStream}} [io]
 * @returns {Promise<string>}
 */
export async function readSecretFromStdin({ stdin = process.stdin } = {}) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const first = Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? '';
  return first.trim();
}
