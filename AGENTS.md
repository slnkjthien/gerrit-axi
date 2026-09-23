# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge:
build, test, release, architecture, and sharp-edge notes that should travel with
the code.

- `npm test` runs `node --test` over `test/*.test.js`. Zero dependencies, runtime
  and dev — keep it that way unless there is a concrete reason not to.
- Tests must stay offline. Core's HTTP client (`fetchImpl`), subprocess runner
  (`runner`), `env`, and `cwd` are all injectable parameters precisely so fixtures
  can drive the real code paths; add a fixture rather than a network call.
- Releases are cut by pushing a `v<version>` tag that matches `package.json`;
  `.github/workflows/release.yml` tests, packs and attaches the tarball to a
  GitHub Release. The distributed artifact is always CI's, never a local `npm pack`.

## Invariants, and where they are enforced

These are load-bearing design decisions, not preferences. `test/layering.test.js`
fails if any of them is broken, which is the intended way to find out.

- `src/core/` returns data and never formats it: no tables, colour, column widths,
  or `console.*`. Rendering lives only in `src/cli/` and `src/axi/`.
- No hostname literal anywhere in `src/` or `bin/` (RFC 2606 `example.*` names in
  usage text are the only exception). Host/port/user/project come from the
  `origin` git remote, then env, then config file — see the three-tier model in
  README.md.
- The git-remote tier answers only for a remote recognised as Gerrit's, by URL
  shape plus (for ambiguous shapes) corroborating repo evidence — never a forge
  deny-list, which the no-hostname-literal rule forbids anyway. Rejected remotes
  drop host/port/user/project as a unit; see `acceptGerritRemote` in
  `src/core/remote.js` and the tests in `test/config.test.js`.
- No label name is ever hardcoded. Readiness comes from the server's submit
  records via `deriveReadiness` in `src/core/changes.js`; `test/readiness.test.js`
  greps core to enforce it.
- Every `gerrit query` sends `--current-patch-set --all-approvals
  --submit-records`. Anything else is opt-in per call and named through the
  `DETAIL_QUERY_FLAGS` allowlist in `src/core/ssh.js` — a caller passes a key,
  never a flag string, so nothing caller-supplied reaches argv. Add a detail flag
  there rather than at a call site.
- A resolved `user` or `host` never begins with `-`, because ssh would read it as
  an option. `resolveConfig` enforces this through `assertSafeConnection` in
  `src/core/ssh.js`, so a transport built on the resolved config inherits it; one
  taking a connection from anywhere else must call it itself.
- Nothing can vote. The only writes are `gerrit-axi publish` (one push to
  `refs/for/`, built only by `buildPushArgs` in `src/core/publish.js`),
  `gerrit-axi submit` (the one POST, in `restSubmit` in `src/core/rest.js`) and
  `gerrit-axi message` (one `gerrit review --message`, built only by
  `buildMessageArgs` in `src/core/message.js`); the human `gerrit` stays read-only.
  `gerrit review` is the command that votes, so it may be spelled in
  `src/core/message.js` and nowhere else, and there only as the literal argv
  `gerrit review --message <quoted text> <change>,<patchset>` with no parameter
  for another option; a REST `/review` or `/votes` path, `set-reviewers`,
  `set-topic`, and a label option on a push may not appear anywhere. The layering
  test's whole-source scan fails if any of that changes; it exempts
  `src/core/message.js` only for spelling the command. That scan reads
  source text on purpose, an exception to asserting behaviour: a security
  invariant needs a whole-source claim. `test/message.test.js` and
  `test/vote-ban.test.js` are its runtime complement and pin the message argv by
  running it; keep all three. Those three are the only writes by design: add no
  other.
- `publish` never regenerates a Change-Id: a new one creates a different change
  and orphans the original's review. An existing one is pushed verbatim; a
  missing one is stamped and written back into the local branch (messages only)
  so the next publish reuses it.
- Prose is written for a stranger running their own server: never assert a fact
  about *the reader's* Gerrit that the tool has not checked (`git_basic_auth_policy`
  is the trap), and never name a specific organisation, project-path prefix, or
  server version in code, tests, comments or docs. `test/layering.test.js` catches
  the hostname and project-prefix cases; the rest is on review.
- `src/axi/` is the agent tier, behind the `gerrit-axi` binary: it imports
  `src/core/` and prints records (TOON by default, JSON under `--json`). It is a
  sibling of `src/cli/`, not a wrapper — it must never import a renderer, parse a
  table, or re-derive readiness. Its records are flat tables joined on
  `(change, label)`, never one nested object per change, because that is what
  survives a server growing a label. Errors go to stderr as a typed record with
  stdout empty. `gerrit` still has no `--json` and must not grow one: a request
  for machine-readable output is a request for `gerrit-axi`.
- A bare `gerrit-axi`, or one given only options, is the dashboard (`opDashboard`
  in `src/axi/commands.js`), never usage; usage prints only for `--help`, `-h` and
  `help`, and an unresolvable host is the ordinary `HOST_UNRESOLVED` error record.
  Its four sequential `gerrit query` calls are the floor, not laziness: a query row
  carries neither the attention set nor reviewer-vs-CC state, so sections cannot be
  split locally from one query. `test/axi.test.js` holds the no-host case.
- Negation in a built query is spelled `NOT`, never a leading `-` (see `buildQuery`
  in `src/core/changes.js`): over ssh the query is words of a remote command line,
  and Gerrit reads a word beginning with `-` as an option of `gerrit query`.
- Every subcommand's options are listed in the top-level `--help` of its own
  binary as well as in its usage string. Options that appear only in the
  subcommand's help have been missed in practice; `test/review-state.test.js` and
  `test/axi.test.js` check the top-level help mentions them.
- `gerrit-axi`'s options have one catalogue, `COMMAND_OPTIONS` in
  `src/axi/args.js`: the parser rejects by it, the unknown-option record lists
  from it, and the help-coverage test reads it. An option a command does not take
  is refused by name with a `BAD_USAGE` record whose `remedy` lists that
  command's options and the global ones, before anything is asked of git or the
  server; add an option there and in `USAGE` in `src/axi/main.js`, never at a
  call site.

## Credential handling

`src/core/credentials.js` documents the invariants at the top of the file. The two
that are easy to break by accident: a credential must never reach argv (pass it on
a child's stdin, or in an HTTP header of the in-process client), and a token must
never appear in output, logs, error messages, fixtures, or the repo.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this
project.
Do not repeat what the codebase already shows; point to the authoritative file or
command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
