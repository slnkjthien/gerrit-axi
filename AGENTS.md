# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge:
build, test, release, architecture, and sharp-edge notes that should travel with
the code.

- `npm test` runs `node --test` over `test/*.test.js`. Zero dependencies, runtime
  and dev — keep it that way unless there is a concrete reason not to.
- Tests must stay offline. Core's HTTP client (`fetchImpl`), subprocess runner
  (`runner`), `env`, and `cwd` are all injectable parameters precisely so fixtures
  can drive the real code paths; add a fixture rather than a network call.

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
- v0.1 is read-only. No mutating REST verb and no mutating `gerrit` SSH
  subcommand may appear in the codebase.
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
- Every subcommand's options are listed in the top-level `--help` of its own
  binary as well as in its usage string. Options that appear only in the
  subcommand's help have been missed in practice; `test/review-state.test.js` and
  `test/axi.test.js` check the top-level help mentions them.

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
