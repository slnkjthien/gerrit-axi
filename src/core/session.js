// SPDX-License-Identifier: Apache-2.0

/**
 * A Session bundles resolved configuration with the injectable edges of the
 * process -- the subprocess runner, the HTTP client, and the working directory
 * whose repository a publish reads.
 *
 * It is the entry point of the library API. The agent tier in src/axi/ constructs
 * a Session and calls the same functions the CLI calls; it does not spawn
 * `gerrit` and scrape stdout. Both layers are Node, so no subprocess boundary
 * should exist between them. That is why every dependency here is a parameter
 * rather than a global reference: the same code path is what the tests drive,
 * with no network and no Gerrit server.
 */

import { resolveConfig } from './config.js';
import { clearToken, detectBackend, loadToken, requireToken } from './credentials.js';
import { runCommand } from './exec.js';

/** @typedef {import('./config.js').ResolvedConfig} ResolvedConfig */

export class Session {
  /**
   * @param {{config: ResolvedConfig, env?: NodeJS.ProcessEnv,
   *          runner?: import('./exec.js').Runner, fetchImpl?: typeof fetch,
   *          cwd?: string}} deps
   */
  constructor({ config, env = process.env, runner = runCommand, fetchImpl, cwd = process.cwd() }) {
    /** @type {ResolvedConfig} */
    this.config = config;
    this.env = env;
    this.cwd = cwd;
    this.runner = runner;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    /** @type {Promise<{token: string, backend: string, location: string|null}>|null} */
    this._token = null;
  }

  /** Identity under which credentials are stored. */
  get credentialId() {
    return {
      host: this.config.host,
      user: this.config.user,
      env: this.env,
      runner: this.runner,
    };
  }

  /**
   * The stored token, or an AuthError with a remedy. Memoised so one command does
   * not prompt the keyring repeatedly.
   *
   * @returns {Promise<{token: string, backend: string, location: string|null}>}
   */
  token() {
    this._token ??= requireToken(this.credentialId);
    return this._token;
  }

  /**
   * Everything rest.js needs for an authenticated call. The token lives only in
   * this object and the request header built from it.
   *
   * @returns {Promise<import('./rest.js').RestTarget>}
   */
  async restTarget() {
    const { token } = await this.token();
    return {
      restBase: this.config.restBase,
      user: this.config.user,
      token,
      fetchImpl: this.fetchImpl,
    };
  }

  /**
   * Cache an already-verified token for the rest of this session, so a fresh
   * `auth login` does not immediately read back what it just wrote.
   *
   * @param {string} token
   * @param {{backend?: string, location?: string|null}} [where]
   */
  rememberToken(token, { backend = 'file', location = null } = {}) {
    this._token = Promise.resolve({ token, backend, location });
  }

  /** @returns {Promise<{token: string, backend: string, location: string|null}|null>} */
  peekToken() {
    return loadToken(this.credentialId);
  }

  /** @returns {Promise<import('./credentials.js').Backend>} */
  bestBackend() {
    return detectBackend({ env: this.env, runner: this.runner });
  }

  /** @returns {Promise<{removed: import('./credentials.js').Backend[]}>} */
  forgetToken() {
    this._token = null;
    return clearToken(this.credentialId);
  }
}

/**
 * Resolve configuration and build a Session.
 *
 * @param {{overrides?: {host?: string, port?: number|string, user?: string, project?: string},
 *          cwd?: string, env?: NodeJS.ProcessEnv, runner?: import('./exec.js').Runner,
 *          fetchImpl?: typeof fetch, remoteUrl?: string|null}} [opts]
 * @returns {Promise<Session>}
 */
export async function createSession(opts = {}) {
  const { overrides = {}, cwd, env = process.env, runner = runCommand, fetchImpl, remoteUrl } = opts;
  const config = await resolveConfig(overrides, { cwd, env, runner, remoteUrl });
  return new Session({ config, env, runner, fetchImpl, cwd });
}
