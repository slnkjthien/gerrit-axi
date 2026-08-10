/**
 * `gerrit status [mine | <change>... | --query '<gerrit query>']`
 *
 * The BLOCKED-ON column is the whole point of this command, and every value in it
 * comes from the server's submit records. No label name appears anywhere in this
 * file: whatever the server calls its labels is what gets printed, so the tool
 * stays correct across servers and across changes to project.config.
 */

import { queryChanges, sortByLastUpdatedDesc } from '../../core/changes.js';
import { UsageError } from '../args.js';
import {
  abbreviateRevision,
  colorSubmitStatus,
  commonPathPrefix,
  formatDate,
  formatVote,
  measureWidth,
  table,
  terminalWidth,
  truncate,
} from '../render.js';

export const STATUS_USAGE = `usage: gerrit status [mine | <change>... | --query '<gerrit query>']

  (no argument)     your attention set -- the changes where it is your turn
  mine              your open changes
  <change>...       specific change numbers
  --query <q>       an arbitrary Gerrit query

  --labels          add one column per label the server reports
  --patch-set       add the current patch set number and revision
  --limit <n>       maximum changes to fetch (default 100)

A table has room for a vote but not for who cast it, when, or what CI said:
'gerrit show <change>' is the detail view for one change.`;

/** Flags this command understands, for the argument parser. */
export const STATUS_FLAGS = {
  withValue: new Set(['--query', '--limit']),
  boolean: new Set(['--labels', '--patch-set']),
};

/**
 * @param {import('../args.js').ParsedArgs} args
 * @returns {import('../../core/changes.js').QuerySpec}
 */
export function specFromArgs(args) {
  const query = args.flags['--query'];
  const positional = args.positional;

  if (typeof query === 'string') {
    if (positional.length > 0) {
      throw new UsageError('--query cannot be combined with positional arguments');
    }
    if (!query.trim()) throw new UsageError('--query needs a non-empty query');
    return { kind: 'raw', query };
  }
  if (positional.length === 0) return { kind: 'attention' };
  if (positional.length === 1 && positional[0] === 'mine') return { kind: 'mine' };

  for (const arg of positional) {
    if (!/^[0-9]+$/.test(arg)) {
      throw new UsageError(`not a change number: ${arg}\n\n${STATUS_USAGE}`);
    }
  }
  return { kind: 'changes', numbers: positional };
}

/**
 * @param {{session: import('../../core/session.js').Session, args: import('../args.js').ParsedArgs,
 *          out: (line?: string) => void, err: (line?: string) => void,
 *          colorize: (code: string, text: string) => string, width?: number}} ctx
 * @returns {Promise<number>}
 */
export async function runStatus({ session, args, out, err, colorize, width = terminalWidth() }) {
  const spec = specFromArgs(args);

  const rawLimit = args.flags['--limit'];
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new UsageError(`--limit must be a positive integer, got: ${rawLimit}`);
  }

  const changes = sortByLastUpdatedDesc(await queryChanges(session, spec, { limit }));
  if (changes.length === 0) {
    out(describeEmpty(spec));
    return 0;
  }

  // Cosmetic only, and derived from the result set rather than configured.
  const prefix = commonPathPrefix(changes.map((c) => c.project));

  /** @type {import('../render.js').Column[]} */
  const columns = [
    { header: 'CHANGE', value: (c) => String(c.number), align: 'right' },
    { header: 'PROJECT', value: (c) => c.project.slice(prefix.length), max: 28 },
    { header: 'BRANCH', value: (c) => c.branch, max: 20 },
    { header: 'UPDATED', value: (c) => formatDate(c.lastUpdated) },
    { header: 'SUBMIT', value: (c) => colorSubmitStatus(c.readiness.status, colorize) },
  ];

  if (args.flags['--patch-set'] === true) {
    // Enough of the revision to recognise the commit a push just created; the
    // whole of it is one `gerrit show` away.
    columns.push({
      header: 'PATCH-SET',
      value: (c) => (c.currentPatchSet
        ? `${c.currentPatchSet.number ?? '?'}@${abbreviateRevision(c.currentPatchSet.revision)}`
        : '-'),
    });
  }

  if (args.flags['--labels'] === true) {
    // Enumerate whatever labels this result set actually mentions.
    for (const label of labelNamesIn(changes)) {
      columns.push({
        // Wide enough for the label names Gerrit sites actually use, bounded so
        // one verbose label cannot push SUBJECT off the terminal.
        header: truncate(label, 16),
        value: (c) => labelCell(c, label, colorize),
        align: 'right',
      });
    }
  } else {
    columns.push({
      header: 'BLOCKED-ON',
      // Truncate before colouring: slicing a string that already contains ANSI
      // escapes can cut one in half and leave the rest of the line stained.
      value: (c) => (c.readiness.blocking.length
        ? colorize('red', truncate(c.readiness.blocking.join(','), 34))
        : '-'),
    });
  }

  // Give SUBJECT whatever terminal width the other columns leave over, measured
  // rather than guessed (and ANSI-aware, so colour does not shrink it).
  const used = measureWidth(changes, columns) + 2;
  columns.push({
    header: 'SUBJECT',
    value: (c) => `${c.wip ? 'WIP ' : ''}${c.subject}`,
    max: Math.max(24, width - used),
  });

  if (prefix) err(colorize('dim', `projects under ${prefix}`));
  for (const line of table(changes, columns, { colorize })) out(line);

  const ruleErrors = changes.filter((c) => c.readiness.status === 'RULE_ERROR');
  for (const change of ruleErrors) {
    err(colorize('red', `${change.number}: submit rule error: ${change.readiness.errorMessage ?? 'unknown'}`));
  }
  const unknown = changes.filter((c) => c.readiness.status === 'UNKNOWN');
  if (unknown.length) {
    err(colorize('dim', `${unknown.length} change(s) reported no submit record; SUBMIT shows UNKNOWN`));
  }
  return 0;
}

/**
 * Every label name mentioned by any change, whether via a submit record or a
 * vote. Sorted so the column order is stable between runs.
 *
 * @param {import('../../core/changes.js').Change[]} changes
 * @returns {string[]}
 */
export function labelNamesIn(changes) {
  const names = new Set();
  for (const change of changes) {
    for (const label of change.readiness.labels) names.add(label.name);
    for (const vote of change.votes) names.add(vote.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * One cell of the --labels view: the strongest vote if there is one, `!`-marked
 * when the server says that label is what is blocking the change.
 *
 * @param {import('../../core/changes.js').Change} change
 * @param {string} label
 * @param {(code: string, text: string) => string} colorize
 * @returns {string}
 */
function labelCell(change, label, colorize) {
  const verdict = change.readiness.labels.find((l) => l.name === label);
  const vote = change.votes.find((v) => v.name === label);
  if (!verdict && !vote) return colorize('dim', '·');

  const strongest = vote ? (vote.min < 0 ? vote.min : vote.max) : null;
  const text = strongest === null ? '·' : formatVote(strongest);
  if (verdict?.blocking) return colorize('red', `!${text}`);
  if (verdict?.status === 'OK') return colorize('green', text);
  return text;
}

/**
 * @param {import('../../core/changes.js').QuerySpec} spec
 * @returns {string}
 */
function describeEmpty(spec) {
  switch (spec.kind) {
    case 'attention':
      return 'nothing needs your attention';
    case 'mine':
      return 'you have no open changes';
    case 'changes':
      return 'no such change is visible to you';
    default:
      return 'no changes matched';
  }
}
