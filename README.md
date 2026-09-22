# gerrit-axi

A read-only Gerrit CLI. It answers the questions a reviewer actually asks —
*whose turn is it*, *what is blocking this change*, and *where does this one
change stand* — and prints the review comments, inline and cover, including the
machine-generated ones.

Two binaries over one library: `gerrit` renders for a person, `gerrit-axi` emits
records for an agent. They are siblings, not wrappers — see
[The agent tier](#the-agent-tier).

**v0.1 is read-only.** It never votes, replies, sets reviewers or topics, submits,
abandons, or pushes. Every operation is a query. The test suite enforces this: a
grep for mutating REST verbs and mutating `gerrit` SSH subcommands runs as part of
`npm test`.

```console
$ gerrit status
projects under acme/
CHANGE  PROJECT              BRANCH       UPDATED     SUBMIT     BLOCKED-ON                    SUBJECT
184431  apps/widget-daemon   release/7.2  2026-07-31  OK         -                             Bump the retry ceiling to 5
184458  apps/widget-console  main         2026-07-30  NOT_READY  Zebra-Check                   Stop the widget from re-ent…
184402  tools/hammer         main         2026-07-21  NOT_READY  Release-Gate,Widget-Approval  WIP Rewrite the hammer in a…
```

Those label names are examples. The tool has no idea what your server calls its
labels, and that is the point — see [Configuration](#configuration).

## Install

Node 20 or newer. No runtime dependencies.

```sh
git clone <this repo> && cd gerrit-axi
npm link          # or: npm install -g .
```

That installs both binaries: `gerrit` for a person, `gerrit-axi` for an agent.

You also need:

- an **OpenSSH client**, and an SSH key registered with your Gerrit
  (`ssh -p 29418 <you>@<host> gerrit version` should work), and
- a **Gerrit authentication token** for the REST calls — see
  [Authentication](#authentication).

## Commands

```text
gerrit status                      your attention set — the changes where it is your turn
gerrit status mine                 your open changes
gerrit status <change>...          specific change numbers
gerrit status --query '<query>'    an arbitrary Gerrit query
    --labels                       one column per label the server reports
    --patch-set                    add the current patch set number and revision
    --limit <n>                    maximum changes to fetch (default 100)

gerrit show <change>...            one change's review state, in full
    --messages <n|all>             how many cover messages to show (default 10)

gerrit comments <change>           inline review comments
gerrit comments <change> --bots    only machine-generated comments
gerrit comments <change> --humans  only comments that are not machine-generated

gerrit auth login [--stdin]        verify a Gerrit auth token and store it
gerrit auth status                 report whether a stored credential still works
gerrit auth logout                 remove the stored credential
```

Every command's options are listed in `gerrit --help` as well as in
`gerrit <command> --help`, so nothing is discoverable only by knowing it exists.
Global options: `--host`, `--user`, `--port`, `--rest-base`, `--no-color`,
`-h/--help`, `-V/--version`.

Exit codes: `0` success, `1` other error, `2` usage, `3` configuration, `4`
authentication, `5` transport. `gerrit-axi` uses the same ones.

The `gerrit` command has no `--json`, and will not grow one. Machine-readable
output is what the second binary is for.

### Where does this change stand

`gerrit status` is the list view; `gerrit show` is the detail view for one
change. It exists as one command rather than three because the three facts it
prints are asked for together — *is my push on the server, who has voted and how
long ago, and what did CI say and where do I read it*:

```console
$ gerrit show 184458
184458  Stop the widget from re-entering the queue twice
  project     acme/apps/widget-console  (main)
  owner       ada
  status      NEW  ·  submit NOT_READY
  blocked on  Zebra-Check
  updated     2026-08-10  (1h ago)
  patch set   3  aaaa111122223333444455556666777788889999
  ref         refs/changes/58/184458/3
  uploaded    ada  2026-08-10 09:12  (3h ago)
  depends on  184400  dddd111122  superseded -- that change has a newer patch set
  url         https://gerrit.example.com/c/acme/apps/widget-console/+/184458

  votes
    LABEL            VOTE  WHO       WHEN                        SUBMIT
    Release-Gate       +1  buildbot  2026-08-10 09:20  (2h ago)  OK
    Widget-Approval    +1  grace     2026-08-10 10:04  (1h ago)  OK
    Zebra-Check         ·  -         -                           NEED

  messages (the last 2 of 9, oldest first; --messages all for every one)
    2026-08-10 09:20  (2h ago)  [ps3]  <buildbot>
        Patch Set 3: Release-Gate+1

        Build Successful

        https://ci.example.com/job/widget-console/412/ : SUCCESS

    2026-08-10 10:04  (1h ago)  [ps3]  <grace>
        Patch Set 3: Widget-Approval+1

        Reads fine to me now.
```

Three things worth knowing about that output:

- **The revision is printed whole, and the ref beside it.** That line is there to
  be compared against a local `git rev-parse HEAD` after a push. Dependency
  revisions are abbreviated, because those are for recognising rather than
  comparing.
- **`depends on` says whether the revision it names is still that change's
  current patch set.** A stack built on a superseded parent revision is the thing
  you want to find out about before re-reviewing it, not after.
- **Cover messages are printed exactly as the server wrote them**, URLs and all.
  A cover message is Gerrit's change-level conversation — vote summaries, CI
  results, "Uploaded patch set N" — and is a different thing from the inline
  comments `gerrit comments` prints, which belong to a file and a line and come
  over a different transport. `[psN]` is read out of the message's own first
  line, which is a convention of Gerrit's message text rather than a field, so a
  message that does not say gets no marker.

## The agent tier

`gerrit-axi` is the second binary. It imports the core library and prints
records; nothing in it renders a table, and nothing in it reads one. Same
transport, same readiness oracle, same three-tier configuration, same exit
codes — a different output contract.

```text
gerrit-axi status                      your attention set, as records
gerrit-axi status mine                 your open changes
gerrit-axi status <change>...          specific change numbers
gerrit-axi status --query '<query>'    an arbitrary Gerrit query
    --limit <n>                        maximum changes to fetch (default 100)

gerrit-axi show <change>...            full review state, one record per change
    --messages <n|all>                 also emit that many cover messages (default 0)
    --comments                         also emit the inline comments
    --bots | --humans                  with --comments: only / never machine-generated

gerrit-axi comments <change>...        inline review comments on every change named
    --bots | --humans                  only / never machine-generated

gerrit-axi auth status                 whether the stored credential still works
```

Global options: `--json`, `--host`, `--user`, `--port`, `--project`,
`--rest-base`, `-h/--help`, `-V/--version`. As with `gerrit`, every option is
listed in `gerrit-axi --help` too.

### Records, not layout

Output is [TOON](https://toonformat.dev) on stdout, or strict JSON with `--json`.
Both carry the same keys.

```console
$ gerrit-axi show 200101 200102 200103
ok: true
op: show
count: 3
missing: []
changes[3]{change,subject,project,branch,topic,owner,status,wip,submit,submittable,blocked_on,patch_set,revision,ref,updated,created,url}:
  200101,Split the queue reader out of the daemon,acme/apps/widget-console,main,stack-of-three,ada,NEW,false,OK,true,"",4,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,refs/changes/01/200101/4,"2026-07-31T22:13:20.000Z","2026-07-20T08:26:40.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200101"
  200102,Give the queue reader its own retry ceiling,acme/apps/widget-console,main,stack-of-three,ada,NEW,false,NOT_READY,false,"Xylophone-Gate,Zebu-Herding",2,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/2,"2026-08-02T02:00:00.000Z","2026-07-21T12:13:20.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200102"
  200103,Wire the retry ceiling to the managed configuration,acme/apps/widget-console,main,stack-of-three,ada,NEW,true,NOT_READY,false,Quokka-Review,1,cccccccccccccccccccccccccccccccccccccccc,refs/changes/03/200103/1,"2026-08-03T05:46:40.000Z","2026-07-22T16:00:00.000Z","https://gerrit.example.com/c/acme/apps/widget-console/+/200103"
labels[7]{change,label,status,blocking,by}:
  200101,Quokka-Review,OK,false,grace
  200101,Xylophone-Gate,OK,false,buildbot
  200102,Quokka-Review,OK,false,grace
  200102,Xylophone-Gate,NEED,true,null
  200102,Zebu-Herding,NEED,true,null
  200103,Quokka-Review,REJECT,true,alan
  200103,Xylophone-Gate,OK,false,buildbot
votes[6]{change,label,value,by,granted}:
  200101,Quokka-Review,2,grace,"2026-07-31T21:56:40.000Z"
  200101,Xylophone-Gate,1,buildbot,"2026-07-31T22:05:00.000Z"
  200102,Quokka-Review,2,grace,"2026-08-02T01:43:20.000Z"
  200103,Quokka-Review,1,grace,"2026-08-02T15:53:20.000Z"
  200103,Quokka-Review,-2,alan,"2026-08-03T03:00:00.000Z"
  200103,Xylophone-Gate,1,buildbot,"2026-08-02T18:40:00.000Z"
depends_on[2]{change,related,revision,ref,current}:
  200102,200101,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,refs/changes/01/200101/4,true
  200103,200102,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/1,false
needed_by[2]{change,related,revision,ref,current}:
  200101,200102,bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,refs/changes/02/200102/2,true
  200102,200103,cccccccccccccccccccccccccccccccccccccccc,refs/changes/03/200103/1,true
```

Four properties are the point of that shape, and each one replaces a thing a
shell script screen-scraping `gerrit`'s table had to do by hand:

- **One invocation, a whole list.** A watch following a nine-change stack makes
  one call and gets nine records. `status` and `show` both send a single
  `gerrit query`; `comments` needs one REST call per change, because that is what
  the endpoint offers.
- **Labels are keyed by name, never by column.** Per-change scalars live in
  `changes`; anything per-label lives in `labels` and `votes`, joined on
  `(change, label)`. `200102` above carries a label the other two do not, and it
  arrives as an extra row — no header changes, so nothing a consumer reads by
  name moves. `blocked_on` is the server's own blocking-label list, joined, for a
  watch that wants to diff one string; the `labels` table is the authority.
- **Readiness is the server's verdict, not arithmetic over votes.** `submit`,
  `submittable`, and each label's `status` come from `--submit-records` through
  core's `deriveReadiness`. No label name appears anywhere in the tier.
- **A change that is gone is data.** Numbers the server did not return come back
  under `missing`, so "abandoned, or no longer visible to you" is distinguishable
  from "the call failed".

`show` asks the server for the cover messages only when `--messages` will emit
them, because that detail costs work per row. The stack is always asked for: a
parent revision going stale is what a stack watch exists to notice.

### Inline comments

Inline comments are where a reviewer actually reviews, and the SSH cover messages
do not carry them — so this is the only path that reaches them, and `bot` is
typed rather than implied:

```console
$ gerrit-axi comments 200103
ok: true
op: comments
count: 3
comments[3]{change,file,line,patch_set,author,bot,bot_kind,unresolved,severity,id,in_reply_to,updated,message}:
  200103,/PATCHSET_LEVEL,null,1,review-assistant,true,ai-review,false,null,stk0001,null,"2026-08-03T07:41:02.000Z",Reviewed patch set 1. Found 1 issue.
  200103,src/main/java/com/acme/widget/RetryCeiling.java,18,1,review-assistant,true,ai-review,true,null,stk0002,null,"2026-08-03T07:41:03.000Z","[issue] The managed value is read before the provider is bound."
  200103,src/main/java/com/acme/widget/RetryCeiling.java,18,1,alan,false,null,true,null,stk0003,stk0002,"2026-08-03T09:02:55.000Z","Right, and the parent change has to land first."
```

`bot` is Gerrit's own `autogenerated:` tag convention and `bot_kind` is the
suffix the bot declared, so a reviewer nobody has heard of is classified the
first time it posts — see [Tier 1](#tier-1--derived-from-the-server). `severity`
is `null` unless [tier-3 patterns](#tier-3--genuinely-local-convention) are
configured. `gerrit-axi show --comments` adds this same table to a `show`, so one
invocation can answer a whole watch.

### Failures

A failure writes a typed record to **stderr**, leaves stdout **empty**, and exits
non-zero. A consumer never has to tell data from prose:

```console
$ gerrit-axi comments 200103; echo "exit=$?"
ok: false
op: comments
error: "no such resource: /a/changes/200103/comments (HTTP 404)"
code: NOT_FOUND
kind: transport
remedy: Check the change number; a change you cannot see also reads as 404.
exit=5
```

`code` is core's machine-readable error code and `kind` is the class the exit code
was chosen from (`usage`, `config`, `auth`, `transport`, `gerrit`, `internal`).
`remedy` appears only when core supplied one, and is a hint for whoever reads the
log — not a field to branch on.

## Authentication

Gerrit answers `WWW-Authenticate: Basic realm="Gerrit Code Review"`. The credential
is **HTTP Basic carrying a Gerrit authentication token** — not an OAuth bearer
token.

Generate one at `https://<your-gerrit-host>/settings/#HTTPCredentials`, then:

```console
$ gerrit auth login
Generate a Gerrit authentication token at:
    https://gerrit.example.com/settings/#HTTPCredentials

Do NOT paste your LDAP/domain password.
Some servers accept one (git_basic_auth_policy = HTTP_LDAP), and that is precisely
why we refuse it: a Gerrit token is revocable and scoped to Gerrit, a domain
password is neither. Only a token will be stored.

Gerrit auth token for ada@gerrit.example.com (input hidden):
authenticated as Ada Lovelace <ada@example.com>
credential stored in the login keyring (encrypted at rest)
```

Non-interactively — for example from a script or an agent — pass the token on
stdin. `auth login` never blocks on a prompt nobody can answer; with no TTY and no
`--stdin` it fails immediately and tells you this:

```sh
read -rs T && printf %s "$T" | gerrit auth login --stdin && unset T
```

### What the tool does with your credential

- **A domain password is refused, on purpose.** Some servers accept one — where
  `git_basic_auth_policy` is `HTTP_LDAP`, Gerrit *will* authenticate a domain
  password — which is exactly why storing one is a bad trade: a Gerrit token is
  revocable and scoped, a domain password is neither.
- **The credential never appears in argv.** `ps` is world-readable. Every
  authenticated HTTP call passes the credential in a request header of an
  in-process HTTP client — nothing is ever shelled out with a credential on a
  command line — and the keyring and GPG helpers receive it on stdin.
- **It is verified before it is persisted.** `auth login` authenticates against
  `/a/accounts/self` first; an unverified token is never written to disk.
- **Storage is the best available, and degrades loudly rather than silently:**

  | order | backend | at rest |
  | --- | --- | --- |
  | 1 | `secret-tool` (libsecret keyring) | encrypted |
  | 2 | `gpg --encrypt --default-recipient-self` | encrypted |
  | 3 | file under `$XDG_CONFIG_HOME/gerrit-axi/credentials/`, mode `0600` | **plaintext** |

  Every `login` reports which backend it used. When it falls back to the file it
  says the word *plaintext* and names the upgrade path; `gerrit auth status`
  repeats both. Directories are `0700`, files are `0600`.
- **The token is never echoed, logged, or included in any output or error
  message**, and no token — real or otherwise — appears in this repo or in any
  test fixture.

## Configuration

The guiding principle: **derive from the server, then from the repo, and configure
only what genuinely cannot be derived.** There are three tiers, and the first two
have nothing to configure at all.

### Tier 1 — derived from the server

**Label names are never hardcoded.** `Verified` and `Code-Review` come from a
given server's `project.config`, not from Gerrit itself, and a server may define
any number of others alongside them. `gerrit query --submit-records`
returns the server's own verdict — an overall `status` plus a per-label status of
`OK` / `NEED` / `MAY` / `REJECT` / `IMPOSSIBLE` — and *what is blocking this
change* is read straight out of it. This is the readiness oracle; readiness is
never reconstructed from vote arithmetic, so it does not drift when someone edits
the label configuration. `--labels` enumerates whatever labels the result set
mentions, in whatever order the server named them.

**Machine-generated comments are detected via Gerrit's own convention.** Comments
carry a `tag`; automation tags itself `autogenerated:<kind>` — an AI reviewer
posting as `autogenerated:ai-review`, say. `--bots` filters on the
`autogenerated:` prefix and treats the suffix as the bot's self-declared kind, so
a bot nobody configured is recognised the first time it posts. Note these are
ordinary comments — *not* Gerrit's separate robot-comments API — and they carry no
`robot_id`.

### Tier 2 — derived from the repo

Host, port, user and project are resolved in this order, highest first:

1. **Explicit flags** — `--host`, `--user`, `--port`, `--rest-base`.
2. **The `origin` git remote of the current directory** — when it is recognisably
   Gerrit's (see below). This is the primary source, the way `gh` and `glab`
   behave. A Gerrit SSH remote, `ssh://<user>@<host>:29418/<project/path>`, yields
   all four at once; Gerrit's authenticated HTTPS clone URL,
   `https://<host>/a/<project/path>`, yields host, user, project and the REST base.
3. **Environment variables** — `GERRIT_HOST`, `GERRIT_USER`, `GERRIT_PORT`,
   `GERRIT_REST_BASE`.
4. **The config file** (see below).

The remote outranks the environment deliberately: the repo you are standing in
identifies the server you mean, and a stale exported `GERRIT_HOST` should not
silently redirect a question about it. `--host` is the escape hatch.

**A remote that is not Gerrit's contributes nothing at all.** Every addressable
remote URL *parses*, including one belonging to a forge that does not speak Gerrit;
trusting it means an SSH connection to a port nobody serves and ten seconds of
silence before the failure. The remote is therefore judged by its shape — not
against a list of known forges, which would fail open for every forge not on it:

| Remote | Verdict |
| --- | --- |
| `ssh://<user>@<host>:<port>/<project>` | Gerrit — it advertises its sshd port |
| `https://<host>/a/<project>` | Gerrit — the `/a/` authenticated prefix |
| `ssh://<user>@<host>/<project>` (no port) | ambiguous — needs corroboration |
| `https://<host>/<project>` (no `/a/`) | ambiguous — needs corroboration |
| `<user>@<host>:<project>` (scp-style) | not Gerrit — it publishes no such URL |

An ambiguous URL is a shape Gerrit and everyone else both hand out, so the repo
itself is asked to corroborate: a refspec aimed at `refs/for/`, or the `commit-msg`
hook Gerrit tells you to install, recognisable because stamping `Change-Id` is the
whole reason it exists. Without one of those, the remote is ignored.

Ignored means *ignored as a unit*: host, port, user and project all come from that
one URL, so they fall away together and resolution continues at the environment.
Nothing from another forge is ever mixed into an environment-supplied host. In a
GitHub checkout with nothing configured you get the unresolved-host error below
immediately, with one extra line naming what happened:

```console
$ gerrit status
error: cannot determine the Gerrit host

This repo's git remote (git@github.com:owner/repo.git) is not a Gerrit remote, so it was ignored.

Do one of the following:
  ...
```

**There is no built-in default hostname anywhere in the codebase** — a test
enforces that too. Outside a Gerrit repo with no configuration, the tool says it
cannot determine the host and lists every way to fix it:

```console
$ cd /tmp && gerrit status
error: cannot determine the Gerrit host

Do one of the following:
  * run this inside a repo whose 'origin' remote points at Gerrit
        git remote -v   ->   ssh://<user>@<host>:29418/<project/path>
  * export GERRIT_HOST=<host>   (optionally GERRIT_USER, GERRIT_PORT)
  * create /home/ada/.config/gerrit-axi/config.json containing
        { "host": "<host>", "user": "<user>" }
  * pass --host <host> on the command line
```

`gerrit auth status` reports which tier answered for each field:

```console
host:    gerrit.example.com (from git-remote)
user:    ada (from git-remote)
```

### Tier 3 — genuinely local convention

One thing cannot be derived from anything: whether a comment beginning `[issue]`
means something different from one beginning `[suggestion]`. That is whatever
output format your CI happens to use — not Gerrit's, not any bot framework's — so
it lives in the config file and **defaults to empty**. Out of the box the tool
prints raw comments and shows no severity column.

`$XDG_CONFIG_HOME/gerrit-axi/config.json` (i.e. `~/.config/gerrit-axi/config.json`):

```json
{
  "host": "gerrit.example.com",
  "port": 29418,
  "user": "ada",
  "restBase": "https://gerrit.example.com",
  "severity": {
    "patterns": [
      { "name": "issue",      "pattern": "^\\s*\\[issue\\]",      "flags": "i" },
      { "name": "suggestion", "pattern": "^\\s*\\[suggestion\\]", "flags": "i" }
    ]
  }
}
```

`severity.patterns` schema — every field of every entry:

| field | type | required | meaning |
| --- | --- | --- | --- |
| `name` | string | yes | the label attached to a matching comment, shown as `[name]` |
| `pattern` | string | yes | a JavaScript regular expression source, tested against the comment body |
| `flags` | string | no | regexp flags; defaults to `"i"` |

Order is precedence: the **first** matching pattern wins. An invalid regexp is
reported when the config is read, not partway through a result set. Omit the
`severity` block entirely — the default — and classification is a strict no-op.

`restBase` is only needed for deployments behind a path prefix or a non-standard
web port; otherwise it is derived as `https://<host>`.

Display-path shortening is cosmetic and also derived rather than configured: the
longest path prefix the result set actually shares is stripped, and the tool prints
what it removed (`projects under acme/`). A single-row result is never abbreviated.

## Architecture

One npm package, three internal modules, and a hard boundary around the first.

```text
src/core/   auth, transport, config resolution, typed models.  NO OUTPUT FORMATTING.
src/cli/    human-facing rendering and interactive prompts.    bin: gerrit
src/axi/    machine-facing records: TOON, or JSON.             bin: gerrit-axi
```

`src/cli/` and `src/axi/` are siblings. Neither imports the other, and neither
knows the other exists.

Two rules decide whether this design survives, and both are enforced by tests in
`test/layering.test.js`:

1. **`src/core/` returns data and never formats it.** No tables, no colour, no
   column widths, no `console.log`. Nothing under `src/core/` knows what a table
   looks like; it returns plain typed objects and `src/cli/` decides how they look.
2. **The second binary `import`s core; it does not spawn the CLI.** A wrapper is
   entitled to shell out to a CLI when that binary is foreign — compiled Go, say.
   Both of these layers are Node, so no subprocess boundary should ever exist
   between them. `src/core/index.js` is shaped as a library API over typed
   objects, not as something to be screen-scraped:

   ```js
   import {
     createSession, queryChanges, queryChangeDetails, listComments,
   } from 'gerrit-axi/core';

   const session = await createSession();                    // tier-2 resolution
   const changes = await queryChanges(session, { kind: 'attention' });
   const blocked = changes.filter((c) => c.readiness.blocking.length > 0);
   const bots = await listComments(session, 184458, { botsOnly: true });

   const [change] = await queryChangeDetails(session, [184458]);
   change.currentPatchSet.revision;                          // what the server has
   change.votes[0].votes[0].by;                              // who, and .grantedOn when
   change.messages.flatMap((m) => m.urls);                   // where CI posted its logs
   ```

`src/axi/` is that second binary, and [The agent tier](#the-agent-tier) is what it
prints. It reaches Gerrit only through `src/core/`: `main.js` dispatches and turns
a thrown error into a record, `commands.js` calls core and assembles a document,
`records.js` projects core's typed models onto named fields, and `toon.js`
serialises. Its own tests read every table back by field name, the way a consumer
does.

That layout is why the human `gerrit` has no `--json`. A second output contract
inside the renderer would have to be kept in step with the tables beside it,
forever; a second binary over the same library has nothing to keep in step. So a
request for machine-readable output is a request for `gerrit-axi`, and
`test/layering.test.js` fails if `--json` appears under `src/cli/`.

Every edge of the process — the HTTP client, the subprocess runner, the
environment, the working directory — is a parameter rather than a global
reference. That is what lets the whole stack be driven from recorded fixtures.

### Transport

Two channels, both necessary:

- **SSH** — `ssh -p <port> -- <user>@<host> gerrit query --format=JSON
  --current-patch-set --all-approvals --submit-records ...` for change queries.
  Those three flags are what make the readiness oracle possible. Gerrit's SSH
  daemon parses the remote command itself, but host and port are data read off a
  git remote, so queries are screened for shell metacharacters before being sent
  in case they arrive somewhere with a real shell. For the same reason a user or
  host that begins with `-` is refused wherever it came from, since ssh would
  read it as an option rather than a destination.

  `gerrit show` adds `--comments` (the cover messages) and `--dependencies` (the
  stack, with its `isCurrentPatchSet` flag). Both are opt-in per call, and named
  through an allowlist rather than passed through, so that no caller-supplied
  string can become an element of the argv — and so a hundred-row list view never
  pays for a hundred message timelines.
- **REST** — `https://<host>/a/...` with Basic auth, for inline comments, which
  SSH cannot reach. Gerrit prefixes every REST JSON body with the XSSI guard line
  `)]}'`, which is stripped before parsing.

HTTP 401, 403 and 404 are kept distinct: 401 means the credential is bad or
expired and is the only one that tells you to re-run `auth login`; 403 means you
authenticated but may not read that resource; 404 means no such change (or one you
cannot see).

## Tests

```sh
npm test
```

`node:test` and `node:assert` — the runner Node 20 already ships, chosen so the
package keeps zero dependencies, runtime *and* development.

**No test makes a network call or contacts any Gerrit server.** Recorded fixtures
live in `test/fixtures/`, and because core's HTTP client and subprocess runner are
injectable, the real code paths run against them. Covered in particular:

- configuration precedence, Gerrit SSH remote parsing, and the
  no-host-determinable error path
- deriving blocking labels from submit-record fixtures — the fixtures use invented
  label names, and a test greps `src/core/` to prove none is hardcoded
- `autogenerated:` bot-comment filtering, including that the same account's
  untagged comment is *not* treated as a bot's
- the review-state view: cover messages ordered and parsed from a recorded
  `--comments --dependencies` response, votes carrying who cast them and when, a
  blocking verdict printed against the vote the server credited it to, and the
  detail allowlist refusing a key it does not know
- the XSSI `)]}'` strip, and 401/403/404 staying distinct
- severity classification with an empty config (a strict no-op) and with patterns
- the credential store: file modes, per-host isolation, loud degradation, and a
  stub `secret-tool` that records its argv so "the token never appears in argv" is
  a test rather than a comment
- the agent tier end to end from a recorded three-change stack: one invocation
  returning one record per change, a label the server has grown arriving as a row
  with no header change, the inline-comment path attributed per change, `--json`
  carrying the same fields, and a failure landing on stderr as a typed record
  with stdout empty
- the TOON encoder's quoting and escaping, so a consumer can always tell a string
  from a number, a null, or a delimiter
- the layering rules, the absence of any hostname literal, and that v0.1 mutates
  nothing

The one thing the suite cannot check on a machine without them is the
`secret-tool` and `gpg` backends against a *real* keyring or GPG key; those are
exercised against a stub.

## Licence

Apache-2.0. `LICENSE` has the full text; `NOTICE` carries the copyright, which is
Spectralink Corporation's.
