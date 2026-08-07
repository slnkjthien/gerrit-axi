/**
 * `gerrit auth login | status | logout`
 *
 * The prompt copy here is load-bearing, not decoration: it is where the tool
 * refuses to help you store an LDAP/domain password and says why. On a server
 * whose `git_basic_auth_policy` is HTTP_LDAP a domain password *would*
 * authenticate -- which is exactly why the refusal has to be explicit.
 */

import { authStatus, loginWithToken, logout, tokenSettingsUrl } from '../../core/auth.js';
import { GerritError } from '../../core/errors.js';
import { UsageError } from '../args.js';
import { readSecret, readSecretFromStdin } from '../prompt.js';

export const AUTH_USAGE = `usage: gerrit auth <login|status|logout>

  login [--stdin]   verify a Gerrit auth token and store it
  status            report whether a stored credential exists and still works
  logout            remove the stored credential`;

/**
 * @param {{session: import('../../core/session.js').Session, args: import('../args.js').ParsedArgs,
 *          out: (line?: string) => void, err: (line?: string) => void,
 *          colorize: (code: string, text: string) => string,
 *          stdin?: NodeJS.ReadStream, stderr?: NodeJS.WriteStream}} ctx
 * @returns {Promise<number>} exit code
 */
export async function runAuth(ctx) {
  const sub = ctx.args.positional[0] ?? 'status';
  switch (sub) {
    case 'login':
      return authLogin(ctx);
    case 'status':
      return authStatusCmd(ctx);
    case 'logout':
      return authLogout(ctx);
    default:
      throw new UsageError(`unknown auth subcommand: ${sub}\n\n${AUTH_USAGE}`);
  }
}

/** @param {Parameters<typeof runAuth>[0]} ctx */
async function authLogin({ session, args, out, err, colorize, stdin = process.stdin, stderr = process.stderr }) {
  const { config } = session;
  const settingsUrl = tokenSettingsUrl(session);
  let token;

  if (args.flags['--stdin'] === true) {
    token = await readSecretFromStdin({ stdin });
    if (!token) throw new GerritError('no token on stdin', { code: 'EMPTY_TOKEN' });
  } else if (stdin.isTTY) {
    err(`Generate a Gerrit authentication token at:`);
    err(`    ${settingsUrl}`);
    err('');
    err(colorize('yellow', 'Do NOT paste your LDAP/domain password.'));
    err('Some servers accept one (git_basic_auth_policy = HTTP_LDAP), and that is precisely');
    err('why we refuse it: a Gerrit token is revocable and scoped to Gerrit, a domain');
    err('password is neither. Only a token will be stored.');
    err('');
    token = (await readSecret(
      `Gerrit auth token for ${config.user}@${config.host} (input hidden): `,
      { stdin, stderr },
    )).trim();
    if (!token) throw new GerritError('no token entered', { code: 'EMPTY_TOKEN' });
  } else {
    // Never block on a prompt nobody can answer.
    throw new GerritError('no interactive terminal available', {
      code: 'NO_TTY',
      remedy: [
        'Either run this in your own terminal:',
        '    gerrit auth login',
        'or feed the token on stdin without echoing it to a screen or a file:',
        '    read -rs T && printf %s "$T" | gerrit auth login --stdin && unset T',
        '',
        `Tokens are generated at ${settingsUrl}`,
      ].join('\n'),
    });
  }

  // Verified against /a/accounts/self before anything is written to storage.
  const { account, store } = await loginWithToken(session, token);
  token = '';

  out(`authenticated as ${account.name ?? account.username ?? 'unknown'}`
    + `${account.email ? ` <${account.email}>` : ''}`);

  for (const step of store.degraded) {
    err(colorize('yellow', `note: ${step}; falling back`));
  }

  if (store.backend === 'secret-tool') {
    out('credential stored in the login keyring (encrypted at rest)');
  } else if (store.backend === 'gpg') {
    out(`credential stored gpg-encrypted at ${store.location} (mode 0600)`);
  } else {
    out(`credential stored at ${store.location} (mode 0600)`);
    err(colorize('yellow', 'warning: this file is PLAINTEXT at rest.'));
    err(`  upgrade path: ${store.upgradeHint}`);
  }
  return 0;
}

/** @param {Parameters<typeof runAuth>[0]} ctx */
async function authStatusCmd({ session, out, err, colorize }) {
  const status = await authStatus(session);
  const { config } = session;

  out(`host:    ${config.host} (from ${config.sources.host})`);
  out(`user:    ${config.user} (from ${config.sources.user})`);

  if (!status.stored) {
    out('stored:  no credential');
    err('');
    err('Run: gerrit auth login');
    return 1;
  }

  const where = status.backend === 'secret-tool' ? 'login keyring' : status.location;
  out(`stored:  ${status.backend} (${where})`);
  out(`at rest: ${status.encryptedAtRest ? 'encrypted' : colorize('yellow', 'PLAINTEXT')}`);
  if (!status.encryptedAtRest && status.bestBackend !== 'file') {
    err(`note: ${status.bestBackend} is available here; re-run 'gerrit auth login' to upgrade.`);
  }

  if (status.verified) {
    const who = status.account?.name ?? status.account?.username ?? 'unknown';
    out(`token:   ${colorize('green', 'works')} - authenticated as ${who}`
      + `${status.account?.username ? ` (${status.account.username})` : ''}`);
    return 0;
  }

  out(`token:   ${colorize('red', 'rejected')} - ${status.problem?.message}`);
  if (status.problem?.remedy) {
    err('');
    err(status.problem.remedy);
  }
  return 1;
}

/** @param {Parameters<typeof runAuth>[0]} ctx */
async function authLogout({ session, out }) {
  const { removed } = await logout(session);
  if (removed.length === 0) {
    out('no stored credential');
  } else {
    out(`credential removed from: ${removed.join(', ')}`);
  }
  return 0;
}
