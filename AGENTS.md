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
  or `console.*`. Rendering lives only in `src/cli/`.
- No hostname literal anywhere in `src/` or `bin/` (RFC 2606 `example.*` names in
  usage text are the only exception). Host/port/user/project come from the
  `origin` git remote, then env, then config file — see the three-tier model in
  README.md.
- No label name is ever hardcoded. Readiness comes from the server's submit
  records via `deriveReadiness` in `src/core/changes.js`; `test/readiness.test.js`
  greps core to enforce it.
- v0.1 is read-only. No mutating REST verb and no mutating `gerrit` SSH
  subcommand may appear in the codebase.
- `src/axi/` and any machine-readable output mode are deliberately absent, so the
  future agent-facing binary imports `src/core/index.js` instead of parsing the
  CLI. Do not create either without a task that asks for it.

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
