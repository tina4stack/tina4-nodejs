# Changelog

Tina4 keeps ONE version across all four frameworks (Python, PHP, Ruby, Node.js), so a version
number means the same thing everywhere.

**The authoritative release notes for every shipped version live in the documentation:**
https://tina4.com/nodejs/36-releases

## 3.13.119

Version-parity bump. No Node framework code changes; the version
aligns with:

- tina4-php 3.13.119 which ships @MichaelC8E's skill-repair PR
  (tina4-php#205), @cwvermaak-codeinfinity's Messenger AUTH/STARTTLS
  negotiation fix (tina4-php#204), and my ImportHelper autoload
  non-throw fix (regression from 3.13.117 where the last-resort
  spl_autoload_register callback threw and broke class_exists()).
- tina4-ruby 3.13.119 which ships @MichaelC8E's skill-repair PR
  (tina4-ruby#44) and my CLAUDE.md footer bump.
- tina4-python 3.13.119 as a version-parity bump.

Node has no equivalent ImportHelper autoload defect (the exports
wildcard on @tina4/core throws only when the missing module is
imported, not from an autoload callback that class_exists() might
trigger) and no equivalent skill-file corruption from the same
cp1252 round-trip (the Node skill repair from @MichaelC8E landed in
3.13.118 as PR #60 / 2b3f9a277).

## 3.13.118

Skill repair by @MichaelC8E (#60, merged as 2b3f9a277) plus a
version-parity bump alongside the tina4-python regression fix
landing in this same version.

### Skill file repairs (#60)

Three defects fixed across the three skill trees this repo carries
(`.claude/skills/`, `.agents/skills/`, `.cursor/skills/`):

- The Codex and Cursor copies of `tina4-maintainer` were UTF-8-with-BOM
  with both em dashes replaced by the cp1252 round-trip
  `c3 a2 e2 82 ac e2 80 9d`. Corruption sat inside the `description`
  frontmatter (the text that decides when a skill triggers), and the
  BOM sat in front of the opening `---` (which some frontmatter
  parsers reject outright). All eight tracked copies across the
  language ports were byte-identical, so every diff-based check
  reported them clean.
- Two shared files had gone stale against canonical in tina4-python.
  `.claude/skills/tina4-js/SKILL.md` was 88 lines behind and missing
  the entire "Which flow? IIFE spike vs scaffold" section.
  `.claude/skills/tina4-maintainer/references/subsystems.md` still
  claimed `websocket` is NOT a top-level `tina4_python` export (it
  IS; the subpackage is a callable module forwarding to
  `core.router.websocket`).
- The Codex and Cursor copies of `tina4-developer-nodejs` were
  around 60 lines behind `.claude`, and shipped none of the seven
  `references/` files their own SKILL.md cites. Every Codex and
  Cursor user was reading a skill that pointed at documents which
  were not there, including a broken image embed.

### Version-parity

- Framework code unchanged in Node for 3.13.118. The version bump
  matches the tina4-python 3.13.118 regression fix
  (`_import_helper.py` pre-import defect fixed by Michael's
  tina4-python#124 -> 79c9ecdf0) so all four backends carry the
  same version.
- tina4-php and tina4-ruby also bump to 3.13.118 as parity. Their
  parallel skill-repair PRs (@MichaelC8E's tina4-php#205 and
  tina4-ruby#44) sit in the runner queue behind the tina4stack
  Actions backlog and will land in 3.13.119.
- tina4-php#204 (@cwvermaak-codeinfinity's Messenger AUTH/STARTTLS
  negotiation fix) is also queued and will ship in 3.13.119.

## 3.13.117

Agent-experience release. Two paired features (import-hint fallback +
generate-resolution transparency) attack the same defect class: the
framework silently transforming input, then failing downstream with a
message that never names the transformation. See ADR-0062.

### Import-hint fallback on @tina4/core (weaker parity, browsable list)

- `packages/core/package.json` gains an `exports` map with named
  subpaths (`./router`, `./orm`, `./frond`, ...) plus a wildcard tail
  `"./*": "./dist/_missing.js"` that catches unknown subpaths.
- New `packages/core/src/_missing.ts` throws with a browsable list of
  the real subpaths from the same package's exports (parsed at throw
  time from `package.json` next to the module).
- Node's ESM wildcard resolver does NOT pass the requested subpath to
  the target file, so the hint cannot say "did you mean 'router'?"
  the way Python, PHP and Ruby can. It lists the real subpaths so the
  reader can pick. ADR-0062 documents this as an accepted asymmetry.
  TypeScript users get a compile-time "Cannot find module" from tsc
  regardless.
- Only @tina4/core carries the wildcard for this release. Extending
  to @tina4/orm, @tina4/swagger, @tina4/frond, @tina4/cli is a
  follow-up.
- 17 real-subprocess assertions cover positive-happy, negative-hint,
  negative-no-match, masking-gate, and typecheck parity.

### Generate-command resolution transparency

- `tina4nodejs generate model|route|migration|middleware --json`
  emits a versioned envelope on stdout, matching the `generate_v1`
  contract advertised in `commands --json`.
- `--dry-run` computes resolution WITHOUT writing files. Composable
  with `--json`.
- Bare invocation prints a human-readable resolution block to stderr
  naming every transformation, path and warning; files are written
  as before.
- Introduced `SQL_RESERVED_TABLE_NAMES` and `pluralizeReserved` in
  `packages/cli/src/commands/generate.ts` mirroring the Python master.
  `generate model Order` now surfaces the "auto-pluralized"
  transformation and names the `--table X --quote` override flag
  (parsed; the quoted-identifier ORM mode it opts into is tracked at
  tina4-python#123 for a follow-up).
- `commands --json` gains `"resolution_contract": {"version": "1",
  "envelope": "generate_v1"}` in `packages/cli/src/bin.ts`.
- 47 real-subprocess + in-process assertions.

Side-fix surfaced by the new reserved-word policy:

- `generate auth` had two hard-coded `SELECT ... FROM user WHERE ...`
  literals in the register/login templates. With `user` now on the
  reserved list, the generated `User` model's `tableName` becomes
  `users` and the SQL 500'd. Both literals fixed to `FROM users`;
  the coemits test suite catches this end-to-end.

Parity: tina4-python, tina4-php, tina4-ruby ship the same two
features in 3.13.117 through their language-native mechanisms.

## 3.13.116

External PR bundled + version-contract test hardening. Bundles
Michael Coetzee's ServiceRunner.stop() cooperative-instance-stop
port and the parseCliManifest helper against stdout pollution.

### #58 ServiceRunner.stop() cooperates with class-based services

Port of tina4-python #118 by @MichaelC8E. Before this, `stop()` only
flipped `context.running = false` on the ServiceContext. A
`Tina4Service` subclass whose `run()` loops on `shouldStop()` never
exited because `shouldStop()` reads a different flag on the instance,
which the runner never touched. The registry entry already stashed
the instance (via `registerService()`), so the fix routes through it.

- `packages/core/src/service.ts`: `stop()` iterates registered
  services and calls `instance.stop()` before flipping
  `context.running`. Wrapped in try/catch so one misbehaving
  instance can not strand its siblings.
- `test/service.test.ts`: real subclass loops on `shouldStop()`,
  registered via `ServiceRunner.registerService()`, then
  `ServiceRunner.stop("name")` asserts the loop exited before
  the join. Michael's local run: 56 passed, 0 failed.

Merged as ead390c76 on v3. CI green on the PR: test suite (11m54s),
firebird, image boots, snyk. Parity with tina4-python #118,
tina4-php d990d620, tina4-ruby c7ad16e landing in the same version.

### Version-contract test hardening

- `test/_parseCliManifest.ts`: exported helper that locates the
  first `{` in child stdout before JSON.parse, and throws a
  descriptive Error carrying a 400-char stdout slice when the
  payload is missing or malformed. The `_` prefix is the runner's
  convention for helpers that are NOT collected as suites.
- `test/commandsManifest.test.ts`: subprocess env sets
  `NODE_NO_WARNINGS=1` so a runtime deprecation warning cannot leak
  to stdout; both JSON.parse call sites (handler and subprocess)
  route through parseCliManifest so a parse failure surfaces the
  actual stdout instead of a bare SyntaxError.
- `test/parseCliManifest.test.ts`: 4 regression cases (2 positive,
  2 negative). Positive proves noise-prefixed stdout still parses.
  Negative proves no-JSON and malformed-JSON throw with the
  context and the actual stdout slice in the message.

Parity: sibling Python / PHP / Ruby fixes landing alongside for the
same defect class.

## 3.13.115

Targeted bug fix in the dispatch layer plus the shared skill update.
No AI/streaming changes in this release.

### #56 — bundler-renamed handler args mapped to the wrong object

A route handler declared as `async (req2, res) =>` (or any bundler-
renamed / minified first parameter name — `_a`, `$0`, `a`) had its
first argument silently bound to the Response, so every POST body
read as empty. The arg mapper only matched the literal names `req`
and `request`; any other first-arg name fell through to `return res`.

- Arg-mapping logic is now the exported `resolveHandlerArgs()` helper
  in `packages/core/src/server.ts` with a positional-fallback branch.
- Positional fallback: any name not resolved as a route param, `req`
  or `request`, or `res` or `response` binds by position — first
  unmatched name gets the request, the rest get the response.
- By-name resolution still wins over positional; route params still
  take priority.
- Regression test `test/bugfix-56-bundler-arg-mapping.test.ts` covers
  named, bundler-renamed, minified, route-param-priority, zero-arity,
  three-unmatched, and res-alias cases. No mocks — the helper
  receives real request/response identities and equality checks tell
  which one bound where.

### Skill: full-stack project layout

- `.claude/skills/tina4-developer-nodejs/SKILL.md` gains a Project
  layout section that codifies the full-stack paradigm — never
  pollute the root with source, split into `backend/` and `frontend/`
  with per-side `plan/` folders, ask the backend framework before
  scaffolding. See tina4-nodejs#59.

## 3.13.114

Feature: the tool loop closes. `Ai.chat` now sends tool declarations and
carries tool-result turns back on the next turn, provider-neutrally.
ADR-0061.

### AI tool loop (send + return path, provider-neutral)

- `Ai.chat(messages, { tools: [{name, description, parameters}] })` declares
  the tools the model may call. `parameters` is a JSON Schema object,
  passed through unchanged. Translated per provider on the outbound body:
  OpenAI/local as `[{type:'function', function:{name, description, parameters}}]`;
  Anthropic as `[{name, description, input_schema}]` (`parameters` renamed).
- `Ai.chat(messages, { toolChoice })` picks how the model chooses a tool.
  Four values — `'auto' | 'none' | 'required' | {name: 'x'}` — translated
  per ADR-0061's table. `'none'` on Anthropic (which has no "none" mode)
  omits the tools list entirely; the model cannot call what it cannot see.
- `Ai.chat` accepts a tool-result turn in either provider's form:
  * OpenAI-style: `{ role: 'tool', tool_call_id, content }`.
  * Anthropic-style (a user turn): `{ role: 'user', content:
    [{ type: 'tool_result', tool_use_id, content }] }`.
  Whichever the caller sends, the client normalises to the current
  provider's expected shape. An agent loop written against the Tina4
  surface never has to fork on `TINA4_AI_PROVIDER`. Malformed tools /
  tool-result parts raise `AiConfigError` before any request is sent.
- Streaming aggregator (ADR-0060) is unchanged; the receive side now
  composes with the send side into a full agent-loop round trip.

### Types

- New `AiToolDeclaration` and `AiToolChoice` type exports on `@tina4/core`
  (renamed the tool-declaration type off the `AiTool` name to keep clear
  of the existing AI-coding-tool installer type on the same package).
- `ContentPart` extends with `{ type: 'tool_result', tool_use_id, content }`.
- `AiMessage` is now a discriminated union: the three chat roles carry
  string or parts content; the new `tool` role carries `tool_call_id` +
  string content.

### Tests

- `test/aiClientContract.test.ts` extended with 14 new invariant cases
  (13 required by the fixture; one extra negative-validation lock-in),
  driven against a real `http.createServer` fixture that echoes tool
  bodies and streams full OpenAI + Anthropic agent-loop round trips.
  35 / 35 pass, real sockets, no mocks.

## 3.13.113

Feature: typed streaming events, multimodal AI content, and reusable
`Api.stream*` primitives. ADR-0060.

### Api streaming primitives (new)

- `Api.streamBytes(path, opts?)` yields the raw response body chunks in
  transport order, ending on EOF and throwing on transport failure or
  non-2xx status. No JSON decoding, no framing.
- `Api.streamLines(path, opts?)` yields UTF-8 lines split on LF or CRLF,
  buffers a multibyte codepoint across chunk boundaries, and yields a
  trailing line without a terminator on EOF.
- `Api.streamSse(path, opts?)` yields `SseEvent {data, event?, id?, retry?}`
  records with the WHATWG SSE parsing rules — multi-line `data:` fields
  concatenated with `\n`, `:` comment lines ignored, blank lines act as
  boundaries. `data:[DONE]` is delivered as an ordinary event.
- New `StreamOptions` (`method`, `body`, `headers`, `contentType`,
  `timeout`, `connectTimeout`), new `ApiStreamError` type, and exported
  helper functions `parseLineStream` / `parseSseStream` so `Ai.chat`
  streaming shares one framer per language.
- Env vars: `TINA4_API_TIMEOUT` bounds total stream duration,
  `TINA4_API_CONNECT_TIMEOUT` bounds just the connect + headers phase.
  Explicit `opts` fields win. Closing the iterator early destroys the
  socket promptly — no leaked connections.

### Ai.chat streaming — typed events (BREAKING)

- `Ai.chat(stream: true)` now returns `AsyncGenerator<AiEvent>` where
  `AiEvent` is `{type: 'text_delta', text}` | `{type: 'tool_call', id,
  name, args}` | `{type: 'done', finishReason, usage?}` | `{type: 'error',
  message, code?}`. Text deltas arrive per chunk (typewriter UX);
  tool_calls are aggregated per index / content block and emitted once
  when the args JSON parses cleanly; done fires exactly once after all
  deltas; error replaces done on mid-stream failure.
- OpenAI-style `tool_calls[i].function.arguments` fragments are buffered
  per index; Anthropic-style `input_json_delta` under a `content_block_start`
  tool_use block are buffered until `content_block_stop`.
- The stream framer is `Api.parseSseStream` — the same symbol that
  `Api.streamSse` uses, so a fix to SSE handling lands in one place.
- Migration: `for await (const chunk of stream)` becomes
  `for await (const event of stream) if (event.type === 'text_delta') ...`.
  Pre-1.0 API, no shim (ADR-0060 rule 7).

### Ai.chat multimodal content

- `message.content` accepts `string` OR `ContentPart[]` where each part
  is `{type: 'text', text}` or `{type: 'image', source}`. `source` is
  either a `data:<media_type>;base64,<payload>` URI or an `https://`
  URL.
- Providers get their native shape: OpenAI/local emit
  `{type: 'image_url', image_url: {url}}`; Anthropic emits
  `{type: 'image', source: {type: 'base64', media_type, data}}` for data
  URIs and `{type: 'image', source: {type: 'url', url}}` for https.
- Malformed parts (unknown `type`, missing `text`/`source`, wrong scheme,
  empty part list) raise `AiConfigError` before any request goes on the
  wire.

## Unreleased

Bug fix (dev mode only, no production impact). `tina4 serve` served every static
`.html` file over the 1024-byte gzip threshold **corrupt**, and browsers refused
the page outright with `ERR_CONTENT_DECODING_FAILED`. `static.ts` gzips an
eligible file and sets `Content-Encoding` before calling `res.raw.end()`, but
that `end()` is the dev-toolbar wrapper, which saw `text/html`, read the gzip
bytes back as UTF-8 to splice the toolbar in, and turned the `1f 8b 08` magic
into `1f ef bf bd 08`. The wrapper now leaves an already-encoded body alone,
matching the guard `dispatchPipeline.ts` already applies to the sibling
double-gzip case. It hid because curl sends no `Accept-Encoding` by default and
so never took the broken path — only a browser did.

## 3.13.107

Feature: RBAC role and permission guards (parity across all four frameworks).
`role(...)` / `can(...)` route guards read the cryptographically-verified JWT
`roles` / `permissions` claims — OR within a guard, AND by stacking guards, with
granted-side wildcards (`posts.*`, `*`) and a legacy singular `role` claim coerced
to a list. A guarded route implies auth: no or invalid token → 401, authenticated
but unauthorised → 403; the handler never runs on a miss. Feature 138 / ADR-0058.

## 3.13.105

Bug release. Route inspection stops touching the app; Firebird's migration
ledger tolerates whatever case the driver hands back; PHP loses a colon-in-
filename that broke Windows checkouts.

### Route inspection scans, never boots

- `tina4 routes` now walks canonical route files and never executes the
  application entrypoint or starts the server. Feature 115 / ADR-0058.
- Fixes the case where `tina4 routes --override` would boot the app on the
  same port and kill whatever process was already holding it (tina4-python
  issue #104).

### Firebird migration ledger is case-agnostic

- `tina4_migration` reads and writes work regardless of the case the
  Firebird driver returns for the `migration_name` column.
- Uses the atomic sequence table pattern already in place for other engines.

### Runner prints its summary even when stdout is a pipe

- `test/run-all.ts` now sets `process.exitCode` instead of calling
  `process.exit()`. Previously a piped run (`npm test | tee`, a backgrounded
  run, or CI log capture) would truncate the tail of stdout under load and
  drop the `Grand Total` summary line -- the run looked wedged even though
  it had actually finished. Real regression at `test/runnerExitFlush.test.ts`
  (two live node processes over a real OS pipe, no mocks).

### Queue and ORM audit bugs closed

- **`Model.clear_cache()` cascades to `db.cache_clear()`.** Under both
  `TINA4_AUTO_CACHING=true` and `TINA4_DB_CACHE=true`, a manual `clear_cache()`
  used to leave the DB-layer cache holding stale rows (PY-06-22).
- **`Queue.retry()` revives every dead letter.** The no-arg form used a
  generator inside `any(...)` and short-circuited after the first success.
  Now materialised so all N dead letters revive (PY-12-04).
- **`Job.retry()` unlinks the dead-letter file.** Iterating `dead_letters()`
  and calling `.retry()` on each used to leave the failed directory carrying
  every revived job, so the next `dead_letters()` call re-reported them
  (PY-12-05).
- **MongoDB `retry_job(id)` searches the dead-letter namespace by data.id,
  deletes the DL doc, and upserts the original back to pending.** The old
  filter `{_id, self._topic, "failed"}` could never match a dead letter.
- **MongoDB `purge(status)` returns `deleted_count`, honours every status, and
  routes dead/failed/dead_letter aliases to the `.dead_letter` namespace.**
  Previously returned None and only handled `pending` — via `clear()`, which
  nuked every doc under the topic regardless of status.

### Test-harness fixes

- **SIGTERM port probe checks both interfaces.** The graceful-shutdown test
  probed only `0.0.0.0`; on macOS with the framework's default `127.0.0.1`
  listener holding the port, that bind succeeded and the pre-assertion
  concluded the port was free. Now probes both interfaces.
- **MySQL connect-timeout assertion parses the reported elapsed via regex**
  and checks it against the configured bound instead of the outer clock;
  mysql-connector's post-abort cleanup adds ~0.7s that the two stopwatches
  legitimately disagreed on.
- **AI installer tests sandbox `HOME` per-test.** `install_context()` writes
  the global skills bundle to `Path.home()/.claude/skills` by design; in the
  test suite that raced other tests and hit stale root-owned files from prior
  sudo runs. `monkeypatch.setenv("HOME", ...)` redirects the global install
  to a throwaway dir.

### Developer skills — announce and 💩

- **Announce before you act.** All four framework developer skills now
  instruct: say what you are about to do in one line before doing it —
  Plan / Next / Done. Never write more than two files between announcements.
  Never run a schema migration, install a dependency, or edit the boot file
  without a preceding "About to:" line.
- **💩 stale-skill detection.** All four framework developer skills gained
  `updated_for_version: 3.13.105` in the frontmatter and a self-check that
  compares this to the latest published skill version at
  `https://tina4.com/skills/<name>/version` (never against the project's
  framework version — the framework version is the developer's call). If a
  newer skill is available, 💩 rides beside 🤖 on every reply plus a one-time
  update instruction.

### Doc parity

- `Queue.size()`, `Queue.failed()` and `Queue.dead_letters()` gained matching
  in-source docstrings across Python, PHP, Ruby and Node: `size("failed")` /
  `size("dead")` / `size("dead_letter")` are aliases for the dead-letter
  count (== length of `dead_letters()`); `failed()` lists retryable-but-
  attempted jobs, counted under `size("pending")`, NOT `size("failed")`.

## 3.13.103

### Metrics reports what it can prove

- Require signed Tina4 client 3.8.76 for the native metrics handoff.
- Expose `has_referencing_test` as a source-reference signal. It does not claim
  that a test ran or that coverage exists.
- Fail when the native client is stale instead of falling back to a second
  framework-owned analyser.

### Frond stays stable and gets smaller

- Split expression parsing and evaluation into focused internal steps.
- Preserve public APIs and the shared 84-case expression corpus across all four
  languages.

### One client starts every project

- Lead framework skills with `tina4 init` and `tina4 serve`.
- Keep scaffolding guidance visible and separate runtime dependencies from
  language extensions.

### Release integrity

- Align source, runtime, package, lockfile, and AI-facing guide versions.
- Reject a release tag that does not match the source package version before
  any registry publish begins.

+## 3.13.101

### Breaking: metrics has one owner

- Remove the framework `metrics` command and local quick census. Use the native `tina4 metrics` CLI.
- Keep dev-admin metrics as a thin `/metrics/full` and `/metrics/file` JSON handoff to that CLI.

### App-facing AI client

- Add zero-dependency `Ai.chat`, `Ai.complete`, and `Ai.embed`.
- Support local/OpenAI-compatible, OpenAI, and Anthropic chat providers.
- Normalize chat responses, stream ordered deltas, and preserve embedding cardinality.
- Fail closed on missing hosted-provider keys, verify TLS, redact sensitive failures, and
  distinguish bounded connection and total-request timeouts.
- Retry only transient connection, HTTP 429, and HTTP 5xx failures, never a partial stream.

## 3.13.100

### Breaking: Frond instance extensions stay local

Calling `addFilter`, `addGlobal`, or `addTest` on a Frond instance now changes
that renderer only. Register on `Frond` itself when every later instance must
inherit the extension.

- Reject a second `{% extends %}` tag instead of replacing the first parent without warning.
- Preserve nested root blocks through a depth-aware final substitution pass.
- Bound template, fragment, and expression caches, with TTL sweeps for stale entries.
- Retry transport and transient HTTP failures during AI skill downloads; do not retry permanent 4xx responses.
- Activate the tina4-js skill for `tina4js` and `Tina4 JS` spellings as well as `tina4-js`.
- Keep the root package, five published workspaces, npm lockfile, and AI-facing guide on one version.

## 3.13.99

### Breaking: `req.params` is route-params-only

Client input now lives only in `req.query` and `req.body`; `req.params` holds route params
and nothing else, closing a param-pollution surface in the other three frameworks. A
malformed JSON body returns the raw string it failed to parse; an empty body returns `null`.

**Migration.** Replace any `req.params[...]` read of a client-supplied value with
`req.query[...]` or `req.body[...]`.

### Breaking: `Log.warn` is removed, use `Log.warning`

The shared logger conformance runner settled on one name per level across all four
frameworks. Node's `Log.warn` alias is removed; `Log.warning` is the only spelling now. Node
also gains `TINA4_LOG_FILE_LEVEL` (the file sink's level, independent of the console's
`TINA4_LOG_LEVEL`; additive, defaults to `ALL`), and env vars now resolve once at startup
instead of being re-read on every call.

**Migration.** Rename every `Log.warn(...)` call site to `Log.warning(...)`.

### Breaking: `Database.executeMany()` returns one aggregate result

`Database.executeMany()` used to loop per row and return an array of one result per row. It
now delegates once through `adapterExecuteMany()` and returns a single aggregate
`DatabaseResult`, matching `insert`/`update`/`delete`. The rewiring also fixed
`CachedDatabaseAdapter`, which had no `executeManyAsync` passthrough (so a standalone
`executeMany` against any network adapter threw), and `SQLiteAdapter`, whose `executeMany`
issued an unguarded raw `BEGIN`.

**Migration.** Replace any code iterating the old per-row result array with a read of the
single aggregate `DatabaseResult`.

### Breaking: security headers, CSRF, and the dev server default on

`Content-Security-Policy: default-src 'self'` and the other security headers now emit by
default (relax with `TINA4_CSP`; HSTS on HTTPS via `TINA4_HSTS`). The CSRF `403` body is
unified to `{error, code, message, status}`, where Node used to send
`{error: "CSRF_INVALID"}`. `TINA4_CSRF=true` now actually attaches the CSRF middleware, and a
blank `TINA4_SECRET` fails closed instead of minting a forgeable public-default token. The
dev server binds `127.0.0.1` by default (`TINA4_HOST=0.0.0.0` to expose it), refuses a
cross-origin `/__dev` mutation, never serves `.env` through the file endpoints, and now
honours `TINA4_PUBLIC_DIR`.

**Migration.** Set `TINA4_CSP` if you depend on inline scripts or a third-party CDN. Set
`TINA4_HOST=0.0.0.0` if you need the dev server reachable from another machine.

### Breaking: Mongo, Firebird, and MSSQL footguns closed

An unparseable/unsupported MongoDB WHERE now raises instead of silently matching every
document (a DELETE/UPDATE with no WHERE is rejected); `truncate()` on Mongo now actually
empties the collection. MSSQL pagination no longer uses `TOP` for page one; it uses
`OFFSET`/`FETCH` like the other three. `node-firebird` moves from a devDependency to an
optionalDependency of `@tina4/orm`, so it installs only when you use Firebird.
`handle.stop()` on a background task now returns a boolean instead of `void`. Frond
`{% include %}`/`{% extends %}`/`{% import %}` now raise on a path that escapes the templates
directory.

**Migration.** Add an explicit WHERE to any Mongo query relying on the old match-all
fallback, or call `truncate()`. Run `npm install` after upgrading so the Firebird driver
installs correctly if you use it.

### Breaking: ORM relationships, validation, and AutoCrud parity fixes

**Declarative relationships now function and lazy-load.** A field declared with
`type: "foreignKey"` never attached its accessors before; only the imperative
`post.belongsTo(Author, "author_id")` form worked. Both work now. `toDict()` now includes an
imperatively-loaded relation that used to be silently omitted whenever the table name
differed from the lowercased model name, and logs a warning instead of dropping a declared
relation that was not eager-loaded. The imperative `hasMany` cap changes from a silent 100 to
the whole result set. AutoCrud PUT now validates the request body (was create-only): an
update with a type/length/pattern/required violation now gets a `422`, and the `isUpdate`
partial-update mode no longer requires unrelated fields. The regex validation message becomes
`"does not match the required format"`. `createTable()` injects `is_deleted` for a
soft-delete model automatically. AutoCrud never accepts `is_deleted` or a client-supplied
primary key in the write body.

**Migration.** A PUT that previously skipped validation may now fail with `422`. A relation
Node used to silently drop from `toDict()` now appears, or logs a warning.

### Breaking: migrations, response, and dev-tooling fixes

`rollback` is fail-safe now; a missing `.down.sql` file or a failed down script raises and
leaves the `tina4_migration` ledger row in place. **The `tina4 migrate` CLI now runs the same
ORM `migrate()`** (transactional, a robust `;` split, Firebird/MSSQL idempotency skips),
replacing its own naive `split(";")` re-implementation. Responses gzip-compress when
eligible; the static-file ETag format is unified to `W/"<size>-<mtime>"` across all four
frameworks. A `403` now returns a real negotiated body, where it used to return a bare empty
body. The OpenAPI spec now includes routes registered or hot-reloaded after boot, where it
used to freeze at a boot-time snapshot; the Swagger UI CDN default moves to jsdelivr, off
unpkg. A route group's prefix join is normalized. `TestClient` now dispatches through the
real request pipeline instead of short-circuiting around it; `sessionAutoStart` now uses
`appendHeader` so a route-set cookie is no longer clobbered. The banner and health check
report the real framework version instead of `0.0.0`. The inline `tests()` descriptor
builders are renamed `assert*` -> `expect*`.

**Migration.** Rename any `assert*` descriptor call to `expect*`. A test leaning on
`TestClient`'s old short-circuit behaviour may see a different, correct, outcome now.

### Fixed: route path literal-parenthesis 404

`router.ts`'s `compilePattern()` interpolated a literal path segment unescaped, so a route
like `/products/(sale)` 404'd because `(`/`)`/`.` compiled as regex syntax. Only `{param}`
becomes a capture group now.

### Breaking: `toPaginate()` is the seven-key envelope and `.count` is the true total (3.13.96)

Feature 18, ADR-0043. MEASURED 2026-08-05 across all four frameworks on a real
250-row table read with limit=20 offset=40 (page 3 of 13); Node emitted 13 keys,
the worst of the four, and diverged on the values.

- `DatabaseResult.toPaginate()` now takes NO arguments and derives every field
  from the query that ran. Passing any argument RAISES: a `DatabaseResult` holds
  no connection, so an argument could only re-slice rows already in memory and
  report `total_pages` for pages it can never reach. To read page N, FETCH it —
  `db.fetch(sql, params, perPage, (N - 1) * perPage).toPaginate()`.
- The envelope is EXACTLY seven snake_case keys — `records, total, page,
  per_page, total_pages, limit, offset`. Dropped: `data`, `count`, `perPage`,
  `totalPages`, `has_next`, `has_prev` (a JSON key is data, so it stays
  snake_case even though the method name is camelCase).
- `.count` / the envelope `total` is the TRUE total for the filter (a `COUNT(*)`
  probe), NEVER rows-returned, on BOTH read paths that build a `DatabaseResult`:
  `db.fetch()` (already probed) and now `QueryBuilder.get()`, which left `count`
  at rows-returned — diverging from `db.fetch()` AND from Python/Ruby, whose
  `get()` routes through `fetch()`. The probe runs only when a limit was applied.

**Migration.** A caller reading `.count` (or `toPaginate().total`) as the number
of rows a limited query returned must now read it as the filter's true total —
use `records.length` for the page size. Replace `toPaginate(page, perPage)` with a
fetch of that page followed by an argumentless `toPaginate()`. Consumers reading
`data`, `count`, `perPage`, `totalPages`, `has_next` or `has_prev` off the
envelope must move to the canonical seven keys.

### Breaking: Messenger read/send shapes move to the cross-framework contract (3.13.96)

MEASURED 2026-08-06 across all four frameworks against a live GreenMail. Node was
the outlier on each of these; every one now matches the Python reference.

- `send()` carries `{ success, message, id }` on BOTH paths. On failure `id` is
  now present as `null` (it used to be OMITTED), so a caller reading `result.id`
  gets one shape from the success and failure branches. `SendResult.id` is now
  `string | null` and required.
- `inbox()` items are exactly `{ uid, subject, from, to, date, snippet, seen }`,
  `date` is ISO-8601 (was the raw RFC-2822 header), and `snippet` is now real
  decoded, tag-stripped body text (it was ALWAYS `""`, a header-only fetch).
- `read()` returns `date` as ISO-8601 and gains `attachments` (an
  `ImapAttachment[]` of `{ filename, contentType, size }`, empty when none).
- `deleteMessage(uid, folder?)` is renamed to `delete(uid, folder?)` (the one
  cross-framework name). `deleteMessage` stays as a DEPRECATED delegating alias
  for one release.
- New: `markUnread(uid, folder?)` and `sendTemplate(to, subject, template, data?)`
  (renders a Frond template string and sends it as HTML).

**Migration.** A caller that read `result.id` on a failed `send()` must now expect
`null` rather than `undefined`. Persisted `inbox()`/`read()` items that stored
`date` as an RFC-2822 string, or relied on `snippet` being empty, should be
re-read. Replace `messenger.deleteMessage(...)` with `messenger.delete(...)`
before the alias is removed.

### Changed: Swagger/OpenAPI document moves to the reference shape (3.13.96)

MEASURED across the four frameworks; Node moved to the Python reference.

- `components.schemas` is keyed by the model CLASS name (`Item`), not the
  tableName (`items`), so a generated client gets `class Item`. The POST/PUT
  request-body `$ref` resolves to the same class-name schema.
- `info.version` defaults to `1.0.0` (was `0.0.1`) and `info.description` to `""`
  (was a canned sentence). `TINA4_SWAGGER_VERSION` / `_DESCRIPTION` still override.
- A model write documents ONLY `200` with the resource schema. The unconditional
  `422` and the inferred `201` are dropped (both were fiction on a path-inferred
  write); `401` is still added when the route is secured. An explicit
  `meta.responses` is honoured and never clobbered.
- `operationId` preserves leading underscores, so `/__health` -> `get___health`
  and `/health` -> `get_health` are distinct instead of colliding to
  `get_health` + a registration-order-dependent `_2`.

**Migration.** A generated client keyed off the tableName schema name, or reading
`info.version` as `0.0.1`, or branching on a documented `201`/`422` from a model
write, must be regenerated against the new document. Runtime behaviour is
unchanged (the auto-CRUD POST still returns `201`/`422` at runtime; only the
documented response set changed).

### Breaking: `uid` from the Messenger IMAP reads is now a real IMAP UID

`inbox()`, `search()` and `unread()` returned an IMAP **sequence number** in the
field named `uid`, and `read()` / `markRead()` / `delete()` addressed messages by
that same sequence number. They now use the UID form of every command.

MEASURED against live GreenMail. Before an expunge the two numberings are
identical, which is why this survived every existing contract suite:

    send P1 P2 P3     by sequence {1:P1, 2:P2, 3:P3}   by UID {1:P1, 2:P2, 3:P3}
    expunge P1        by sequence {1:P2, 2:P3}         by UID {2:P2, 3:P3}

After that expunge P3 is sequence number 2 and UID 3. Reported for that same
message: python `'2'`, node `'2'`, php `'3'`, ruby `3`. So two of the four
frameworks were handing back sequence numbers.

**Why it matters.** A sequence number renumbers whenever ANY client expunges, so
an id stored today addresses a different message tomorrow - no error, no crash,
just the wrong message. Each framework was internally consistent (reading back by
its own reported id worked), which is exactly why four independently-written
contract suites all passed while two were wrong.

**Migration.** Any `uid` persisted by a previous version must be discarded and
re-read. Those values were never stable - an expunge by any client already
invalidated them - so there is nothing to convert. Values read from this version
onward are stable for the life of the mailbox (IMAP UIDVALIDITY aside).


This file is deliberately NOT a copy of those notes. Duplicating them is exactly how a
changelog rots into claiming a version that was never cut, so this file records only
UNRELEASED work. When a version ships, its notes go to the release notes above.

### Fixed (the object sort spelling threw on the fallback, ADR-0036)

`collection.find({}).sort({ total: -1 })` worked on a real MongoDB and threw

```
TypeError: keyOrList is not iterable
```

on the SQLite fallback. A real `FindCursor.sort()` accepts a field plus a
direction, a list of `[field, direction]` pairs, an object, OR a `Map`, and
ADR-0025 makes the driver the shape this fallback imitates - so all of those now
work here too, via the exported `sortSpec()` helper.

  NOT affected: Node's chain was already lazy and chainable on both providers,
  because a real `FindCursor` is lazy and so is the fallback `Cursor`. That is
  the shape PHP and Ruby were brought to by ADR-0036.

  MEASURED 2026-08-04 against a real MongoDB 7.0.39: 4 chain cases x 2 providers
  x 4 frameworks = 32 combinations, of which **10 failed** before this change and
  0 fail after. Pinned by the substitutability suite in all four frameworks,
  which asserts every spelling on BOTH providers, that `skip` composes, that an
  ASCENDING sort actually ascends (a direction ignored outright would pass a
  descending-only test), and that the chain is LAZY - a document inserted after
  the chain is built but before it is iterated must appear.

### Breaking (`Tina4Request.session` is now `Tina4Session | null`)

**What changed.** `req.session` is typed `Tina4Session | null`. TypeScript will now flag
`req.session.get(...)`, `req.session.set(...)` and every other direct member access.

**Why.** The old type was simply false. The session backend can be unreachable, and the
contract in that case (ADR-0021) is to log the failure and DEGRADE - serve the request
without a session rather than return a 500. Until now the request path did not implement
that at all: `new Session()` and `sess.start()` were unguarded in the dispatch pipeline,
and `sessionAutoStart` sat outside the dispatch try, so an unusable
`TINA4_SESSION_BACKEND` did not degrade, did not 500, it KILLED THE WORKER PROCESS. With
the degrade implemented, `req.session` is genuinely null on that path.

So the compiler is not flagging new failures. It is flagging call sites that were ALWAYS
capable of failing at runtime and had no type-level warning that they were.

**Migration.** Use optional chaining, and decide what your route does without a session:

```ts
// before
const userId = req.session.get("user_id");

// after - read
const userId = req.session?.get("user_id");

// after - when the route genuinely cannot proceed without one
if (!req.session) return res.json({ error: "Session unavailable" }, 503);
req.session.set("user_id", user.id);
```

`TINA4_SESSION_STRICT=true` keeps the old "never serve without a session" behaviour: the
request path re-raises instead of degrading, so a route that reaches your handler always
has one. No framework code dereferences `req.session` (0 call sites), so nothing internal
changed.
### Breaking (DocStore: a missing MongoDB driver now raises)

`TINA4_MONGO_URI` set with the `mongodb` package NOT installed used to throw a bare `ERR_MODULE_NOT_FOUND` naming an npm package rather than the framework decision that led there. It now
raises `DocStoreDriverMissing`, naming the provider and what is missing (ADR-0033,
applying ADR-0024 rule 3).

Re-measured 2026-08-04 at `v3` HEAD in a REAL driverless environment - no mock, no
faked import - one env produced two shapes and four messages across the family:
Python, PHP and Ruby silently returned the local SQLite store, Node threw a bare
`ERR_MODULE_NOT_FOUND`. Silent degradation here means production writes landing in a
container-local file nobody reads, which vanishes on the next deploy, with no error at
any point.

**Migration - one of two lines:**

```
npm install mongodb          # use the real provider
unset TINA4_MONGO_URI        # or use the local SQLite store, explicitly
```

Also changed: `isServerless()` is now CONFIGURATION ONLY. It used to already reflect configuration only - Node was right here, and the other three moved to match it, which is
what routed the call into the local branch; without this an app branching on it would
take the local path and never reach the raise. The error message names the env var that
supplied the URI and never its VALUE, because a Mongo URI routinely carries
`user:password@` and an error string is the most-logged text a framework emits.

### Breaking: the DB query-cache key now carries database identity

CACHE CONTRACT invariant `the-cache-key-carries-database-identity` (ADR-0024).

`QueryCache.queryKey()` returned `query:<sql>:<params>` with nothing naming the
connection, so on ANY shared backend (redis / valkey / memcached / mongodb /
database) two databases cross-served each other's rows. Two apps pointed at one
Redis, or one app with a primary and an analytics connection, silently read each
other's data. Identical SQL text across tenants is the COMMON case, not an edge
case, so the collision was the normal outcome - a data-isolation failure wearing
a caching costume.

The key is now `query:<engine://host:port/database>\0<sql>\0<params>`.
Credentials are excluded on purpose: a password in the key means every rotation
cold-starts the cache, and a shared backend's key namespace is visible to every
tenant of it. Nothing per-process is included either - a pid or a salt would
isolate the databases by accident and destroy the point of a shared cache,
because no instance would ever hit another's entry.

`DatabaseAdapter` gains an optional `cacheIdentity` field, set by
`createAdapterFromUrl()` and the `initDatabase()` config path.
`QueryCache.queryKey(sql, params)` gains an optional third argument; existing
two-argument calls still compile and behave as before (empty identity).

**Migration:** every entry already in a persistent DB query cache
(`TINA4_DB_CACHE=true`) becomes a MISS on upgrade. The cache refills from the
database on first read; expect one cold-cache period per deploy, sized by
`TINA4_DB_CACHE_TTL`. A cold cache is safe, cross-served rows are not. Apps not
running `TINA4_DB_CACHE=true` are unaffected. No action is required.

### Fixed (queue operations acted on the local file store, not the configured backend)

Every operation must act on the CONFIGURED backend. These calls appeared to succeed
while operating on the wrong data, which is the worst failure class because nothing
surfaces it. `pop_by_id` was broken in ALL FOUR frameworks.

- `popBatch()` and `popById()` called `this.liteBackend` unconditionally, so they read
  the LOCAL FILE STORE and never saw a mongodb job. A consumer draining a
  mongodb-backed queue in batches got nothing, forever, with no error. `popBatch` now
  loops the atomic `pop()` on an external backend, and `popById` claims the document
  through a new mongodb operation.

### Fixed (a queue method could be a fatal error instead of resolving)

Every public `Queue` method must RESOLVE on every backend the framework offers. A
method that does not exist cannot even reach a refusal, so the upgrade path is
severed rather than degraded.

- No code change was needed. Node's rabbitmq/kafka throw-at-construction was listed
  in the contract fixture as a violation of this rule; it is not. ADR-0022 decision 8
  chose it deliberately over documenting an at-most-once data-loss footgun. The
  FIXTURE was corrected, and a regression test now pins that those backends refuse
  BY NAME rather than half-working.

### Fixed (queue priority was ignored on every backend but file)

- `push(..., priority)` is now honoured on the `mongodb` backend: priority is stored
  top-level and the dequeue sorts highest-first, ties oldest-first — the same policy
  the file backend already applied. An urgent job queued behind a backlog used to wait
  for all of it in production while prioritising correctly in development. Here the Mongo pop sort was RIGHT all along (`{ priority: -1, createdAt: 1 }`) but
  priority never ARRIVED: the `QueueBackend` interface declared
  `push(queue, payload, delay?)` with no priority parameter, and `Queue.push`
  passed priority only to `liteBackend`. The sort ordered on a field no document
  carried.
- Node already refuses the `rabbitmq` and `kafka` backends outright (ADR-0022), so
  there is no path on which a priority reaches a broker that cannot honour it.

### Fixed (a queue delay was silently dropped on every non-file backend)

- `push(..., delay)` is now honoured on the `mongodb` backend. It was silently DROPPED
  on every non-file backend in ALL FOUR frameworks, so a scheduled job fired immediately
  in production and on time in development. Here the Mongo backend DID write `delayUntil`, but the pop filter put five conditions
  in ONE `$or`, making the reservation gate and the delay gate alternatives rather
  than requirements. A fresh delayed job has no `availableAt`, matched
  `{ $exists: false }`, and was handed straight to a consumer. The two gates are
  now `$and`-ed.
- Node already refuses the `rabbitmq` and `kafka` backends outright (ADR-0022), so
  there is no path on which a delay reaches a broker that cannot honour it.

### Fixed (an unknown queue backend name silently used the file store)

- An unrecognised `TINA4_QUEUE_BACKEND` now RAISES, naming the bad value and the
  valid set, instead of falling through to the local file store. The name is also
  normalised (trimmed + lowercased), so ` RabbitMQ ` resolves.

  WHY: MEASURED 2026-08-03. A typo in `TINA4_QUEUE_BACKEND` produced a RUNNING app
  writing every job to local disk while the operator believed they were in
  RabbitMQ - jobs nothing consumes, on a container filesystem that vanishes on
  the next deploy, with no error at any point.

      python   raised, named the valid set     <- already correct
      ruby     raised, named the valid set     <- already correct
      php      SILENT FALLBACK to file
      nodejs   SILENT FALLBACK to file

  This is the same rule the SESSION backend already adopted, for the same
  reason, so two of four were simply behind.

  Pinned by `test/queueBackendValidation.test.ts`, with a negative case asserting the guard still accepts
  every documented name - without it, "make everything raise" would pass.
  Mutation-proved in both directions (guard disabled, normalisation removed).

### Fixed (array queries diverged from MongoDB, ADR-0025 clause 4)

- A query against an ARRAY field now behaves the way MongoDB behaves. The rule is
  one sentence: a condition on an array-valued field matches when ANY ELEMENT
  matches it (or the whole array equals the operand), and a negation matches when
  NO element does. Implemented over SQLite's `json_each`.

  WHY: MEASURED 2026-08-03 against a real MongoDB with an 18-case matrix. EIGHT
  behaviours diverged IDENTICALLY in all four frameworks, which is the signature
  of a contract nobody had written down:

      tags = "x" against ["x","y"]      mongo 1, fallback 0   (containment)
      tags $in ["x"]                    mongo 1, fallback 0
      nums = 1 against [1,2,3]          mongo 1, fallback 0
      nums $lt 2 against [1,2,3]        mongo 1, fallback 0
      tags $regex "^x$"                 mongo 1, fallback 0
      tags $nin ["x"]                   mongo 0, fallback 1   <- FALSE POSITIVE
      tags $ne "x"                      mongo 0, fallback 1   <- FALSE POSITIVE
      nums $gt 9 against [1,2,3]        mongo 0, fallback 1   <- FALSE POSITIVE

  The three false positives are the worst of it: the fallback returned documents
  Mongo EXCLUDES. `nums $gt 9` matched [1,2,3] because json_extract of an array
  returns its JSON TEXT and SQLite sorts any text above any number - a wrong
  answer, not a missing feature.

  Also fixed in the same pass: an object field is no longer matched by one of its
  values, and IS matched by the whole object.

  Pinned by `test/docstoreSubstitutability.test.ts`, which runs a 20-case matrix against BOTH providers and
  asserts they return the SAME counts - not a hard-coded number, so the test
  cannot drift towards whatever the fallback happens to do. Mutation-proved by
  removing the array branch from equality.

### Fixed (DocStore leaked a Mongo client per call, ADR-0025)

- `getCollection()` cached the connected client instead of building a new one on every
  call. Added `closeDocStore()` to close every Mongo client and the SQLite store.

  WHY: MEASURED 2026-08-03 against a real MongoDB - 20 calls left 40 server
  connections open, growing LINEARLY and without bound. It was invisible in
  development, because the SQLite fallback opens no connections at all: a
  resource leak that existed ONLY after the swap to the real provider, and that
  exhausts the server rather than erroring.

  The cache is keyed per (uri, database) so a reconfigure gets its own client, and it is
  guarded against the check-then-act race in which two concurrent first-callers
  both build a client and one is orphaned - the same leak, just rarer.

  Pinned by `test/docstoreSubstitutability.test.ts`, which drives three identical rounds plus 100 further
  calls and asserts the growth PLATEAUS. That is the distinction that matters: a
  pool legitimately opens several connections and then flattens; a leak keeps
  climbing. Mutation-proved by restoring one-client-per-call.

  NOT affected: PHP. Its ext-mongodb driver pools at the libmongoc level, so
  many Client objects sharing a URI share one pool - measured 0 growth over 60
  calls. It gets the same named test anyway, because correct-for-a-reason-we-did-
  not-choose is exactly what regresses silently.

### Breaking (DocStore is async on both providers, ADR-0025 clause 3)

- The DocStore fallback is now ASYNC, matching the MongoDB driver. `getCollection`
  and every collection method return a Promise; `find()` stays synchronous and
  returns a cursor whose `toArray()` is async - exactly the driver's shape.

      const orders = await getCollection("orders");
      const res    = await orders.insertOne({ total: 9.99 });
      const doc    = await orders.findOne({ _id: res.insertedId });
      for await (const d of orders.find({ total: { $gt: 5 } })) { /* ... */ }

  Also removed, because a real `FindCursor` does not have them:
    - `Cursor[Symbol.iterator]` - use `for await`, not `for ... of`
    - `Cursor.toList()`         - use `toArray()`

  WHY: this was the worst of the four frameworks' DocStore defects, because it
  changed the TYPE rather than the value. `getCollection()` and `insertOne()`
  returned a VALUE on the SQLite fallback and a PROMISE on the real driver, so
  identical source changed shape the moment `TINA4_MONGO_URI` was set - and a
  Promise is ALWAYS TRUTHY, so `if (doc)` succeeded for a document that did not
  exist. A developer got a real document locally and a thenable in production,
  with no error at any point. Measured 2026-08-03 against a real MongoDB.

  ADR-0025: the fallback imitates the driver. A driver cannot become sync, so
  the fallback becomes async. `node:sqlite` is still synchronous underneath -
  the work did not change, only the shape a call site sees, which is the half
  that was broken.

  Pinned by `test/docstoreSubstitutability.test.ts`, which asserts on BOTH
  providers that the entry points are thenable, that the cursor is
  async-iterable, and - the negative case - that it is NOT sync-iterable.

### Fixed (the substitutability harness only ran on one machine)

- `test/docstoreSubstitutability.test.ts` imported the ORM through a hardcoded
  absolute developer path, so it passed locally and died with
  `ERR_MODULE_NOT_FOUND` everywhere else. It was the ONLY failing file in the
  lab suite and had been failing since the harness landed. The path is now
  resolved from `import.meta.url`.

## Unreleased

### Breaking: the rate limiter keys on the socket peer, not X-Forwarded-For

`X-Forwarded-For` is written by whoever sends it. Reading it unconditionally let
any client pick its own rate-limit bucket, and - worse - pick SOMEONE ELSE'S,
exhausting a third party's quota. Measured with `TINA4_RATE_LIMIT=3`: a rotating
`X-Forwarded-For` scored 200,200,200,200,200,200 where a fixed one correctly
scored 200,200,200,429,429,429.

`X-Forwarded-For` and `X-Real-IP` are now read ONLY when the raw socket peer is
listed in the new `TINA4_TRUSTED_PROXIES`. Within the chain the RIGHTMOST hop
that is not itself a trusted proxy wins, matching Rack and Express (a client can
prepend its own hop, so the leftmost entry is attacker-controlled even behind a
real proxy).

**Migration.** If your app runs behind a proxy, load balancer or ingress, set
`TINA4_TRUSTED_PROXIES` to that proxy's address or range. It accepts a
comma-separated mix of exact addresses and CIDR ranges, IPv4 and IPv6:

```
TINA4_TRUSTED_PROXIES=10.0.0.0/8
TINA4_TRUSTED_PROXIES=192.168.1.5, ::1, fd00::/8
```

It is EMPTY by default, which means trust nothing. If you leave it unset behind a
proxy, every client is bucketed under the proxy's address and you will
over-limit. That is deliberate: over-limiting is a degraded service, while the
previous behaviour was an open door. Direct-to-internet apps need no change.

See ADR-0019.
### Breaking: the response cache obeys RFC 9111 (Authorization and Vary)

The response cache keyed entries on method plus URL, with NO request header in
the key. It is a shared, server-side store, so on a secured GET route the first
caller's body was served to every later caller of the same URL. Measured
end-to-end on a real secured route: a valid token for `bob` returned alice's
private body with `X-Cache: HIT`. In Node, where route middleware runs before
the auth gate, an ANONYMOUS request returned 200 with alice's body.

Two RFC 9111 rules now apply, as they do in Varnish, nginx and Rails:

- Section 3 / 3.5: a response to a request carrying `Authorization` is NOT
  stored unless the response carries `Cache-Control: public`, `s-maxage` or
  `must-revalidate`.
- Section 4.1: `Vary` is honoured. The nominated request headers are recorded
  with the entry and must match on lookup; an absent field matches only an
  absent field. `Vary: *` is never stored.

**Migration.** Authenticated GETs are no longer cached by default. If a
response body is genuinely identical for every caller, opt back in per
response:

```typescript
res.header("Cache-Control", "public");
```

Only add it where the body carries nothing user-specific. Public GET caching is
unchanged. See ADR-0020 and `plan/v3/features/043-caching.md`.

### Breaking: an unknown TINA4_CACHE_BACKEND raises instead of falling back to memory

An unrecognised name silently became an in-process memory cache, so a typo
(`TINA4_CACHE_BACKEND=redsi`) produced a running app that shared nothing while the
operator believed it was Redis. It now raises, naming the bad value and the valid
set - the contract `TINA4_SESSION_BACKEND` already uses.

**Migration.** Fix the spelling. Valid: `memory`, `file`, `redis`, `valkey`,
`memcached`, `mongodb`, `database` (plus the aliases `memcache`, `mongo`, `db`).

### CORS denies by default, and never pairs the wildcard with credentials

**Breaking:** `TINA4_CORS_ORIGINS` defaulted to `*`, which allowed every origin
on a fresh install. It now defaults to UNSET, which denies every cross-origin
request: no `Access-Control-Allow-Origin` is sent, and the browser's own CORS
check blocks the request. Django, Rails and ASP.NET all require an explicit
policy before emitting any CORS header, and now so does Tina4.

**Migration:** name the origins your frontend runs on.

```
TINA4_CORS_ORIGINS=https://app.example.com
```

Comma-separate several. `TINA4_CORS_ORIGINS=*` restores the old allow-any
behaviour for anyone who wants it: only the DEFAULT changed, not the capability.
Non-browser clients (curl, server-to-server) never consult CORS and are
unaffected. The status code of a denied preflight is unchanged at 204.

Also in this change:

- `Access-Control-Allow-Origin: *` is never sent alongside
  `Access-Control-Allow-Credentials: true`. The Fetch Standard's CORS check
  treats `*` as a literal once the request carries credentials, so every browser
  rejects the pair. When both are configured the wildcard wins, credentials are
  dropped, and a warning names the fix.
- `Vary: Origin` is now sent whenever the allowed origin is computed from the
  request's `Origin` header, including when the origin is REJECTED. Without it a
  shared cache can store one origin's response and serve it to another
  (RFC 9110 s12.5.5). It is not sent for a constant `*`, which does not vary.
- Every rejected cross-origin request logs an actionable warning naming the
  origin, the environment variable, and the fix. Silence was the common thread
  in every defect this audit found.

See ADR-0018.

### Fixed: the default CORS pipeline now honours `TINA4_CORS_CREDENTIALS`

`startServer` wires `middleware.use(cors())`, and that function form never read
`TINA4_CORS_CREDENTIALS`. Only the opt-in `CorsMiddleware` class did. A
documented environment variable did nothing in the default pipeline.

The cause was two implementations of one feature. `cors()` and `CorsMiddleware`
now share a single `CorsPolicy`, and a conformance test asserts the two produce
identical headers. `resetCorsWarnings()` is exported as a test seam.

### CORS preflight responses now carry `Allow`

A CORS preflight (`OPTIONS` with an `Origin`) returned 204 with the
`Access-Control-*` headers but no `Allow`, while a bare `OPTIONS` to the same
path returned `Allow`. A preflight IS an OPTIONS response, so it now carries
`Allow` too, derived from the router's real method set (RFC 9110 s9.3.7).

This is conformance, not a deviation - see ADR-0013. The frameworks' own
OPTIONS handlers already emit `Allow` (Django's `View.options()`, Express's
router). The add-on CORS libraries omit it only because they short-circuit
ahead of the framework and skip its OPTIONS handler. Tina4 owns both paths in
one dispatcher.

`Allow` and `Access-Control-Allow-Methods` are NOT interchangeable: `Allow` is
what the RESOURCE supports, `Access-Control-Allow-Methods` is what the CORS
POLICY permits cross-origin (`TINA4_CORS_METHODS`, a static list as in every
mainstream library). A policy naming DELETE on a GET-only route is still a 405.

Non-breaking: one added response header on a 204; no existing header changes.


### Breaking: route middleware now runs after the auth gate

Dispatch order is now identical in all four frameworks:

```
pre-match globals -> match -> post-match globals -> auth gate -> route middleware -> handler
```

Node previously ran the route's OWN middleware BEFORE the gate, so middleware
attached to a secured route processed requests that were about to be rejected -
a body parser or audit hook saw unauthenticated traffic. The other three run it
after, as does the mainstream convention (Laravel orders
`->middleware(['auth', ...])` this way; Django puts `@login_required`
outermost). See ADR-0012.

Global middleware is unaffected: it already ran before the gate and still does,
so a global rate limiter or access log continues to see 401s.

**Migration:** middleware passed per-route now only runs for requests that pass
auth. If yours must see rejected requests (rate limiting, access logging),
register it globally with `MiddlewareRunner.use()` instead - and add
`static preMatch = true` if it must also run when no route matched.


### Fixed: a middleware CLASS attached per-route now RUNS

`.middleware(SomeMiddlewareClass)` was inert in Node. `runRouteMiddlewares`
invoked every spec as `mw(req, res, next)`, which for a class throws
`TypeError: Class constructor SomeMiddlewareClass cannot be invoked without
'new'` - so the route answered 500, and `MiddlewareSpec` (`Middleware | string`)
did not admit a class in the first place. Python and PHP have always run
per-route class hooks.

A class attached per-route now runs its `beforeX` hooks through the SAME
`MiddlewareRunner.runBefore` as global middleware - same discovery, same
return-value table, no second runner - and its `afterX` hooks with the global
after pass once the handler is done. Function middleware `(req, res, next)` and
string specs (`"ResponseCache:300"`) behave exactly as before.

**Migration, and the risk here is Node-specific:** a middleware class attached
to a route currently does nothing, so any that were attached speculatively (or
left behind after a refactor) will START EXECUTING. Grep for `.middleware(` and
check every argument that is a class - its `beforeX` hooks can now deny a
request and its `afterX` hooks now run. The equivalent call is broken rather
than silent in the other frameworks (Ruby raises `NoMethodError`), so there the
same change is broken-to-working, not inert-to-live.

Related: the after pass now also runs when a route's middleware
short-circuits. It used to return early, so a response-cache HIT skipped every
global `afterX` hook, and a route middleware that short-circuited WITHOUT ending
the response left the request hanging with no `end()` at all.


### Breaking: what a middleware hook RETURNS decides the pipeline

One table, for every `beforeX`/`afterX` hook, at every scope (global and
per-route):

| the hook returns    | what happens                                                              |
|---------------------|---------------------------------------------------------------------------|
| a Response object   | SHORT-CIRCUIT. That object IS the response, at ANY status.                |
| the `[req, res]` pair | rebind both, continue                                                   |
| `false`             | SHORT-CIRCUIT. Send the response as set; if still default and unwritten, 403. |
| `undefined` / `null`  | continue                                                                |

Node previously honoured only the `[req, res]` pair and IGNORED both a returned
Response object and a returned `false` - a hook that did
`return response.redirect("/login")` had its redirect overwritten by the handler
that then ran anyway.

The Response rule is the PRIMARY mechanism because it is the only one that can
express a 3xx. The old "status >= 400 short-circuits" behaviour is RETAINED as a
legacy compatibility path, so middleware written before this contract keeps
working - but it cannot express a redirect, which is exactly why it is no longer
the main mechanism.

**Migration:** a hook that returned `false` or a Response object was previously
ignored and the handler ran anyway; now it stops the pipeline. That is the
intent of both returns, but if any hook returns a response object
*incidentally* - e.g. `return res.header("X-Trace", id)`, which returns the
response for chaining - it now short-circuits the request. Return `[req, res]`
(or nothing) from a hook that means "continue".


### Fixed: hook discovery dropped every INHERITED hook

`MiddlewareRunner` discovered hooks with `Object.getOwnPropertyNames(cls)`,
which returns a class's OWN statics only. For `class Sub extends Base` with
`static beforeBase` on the base, discovery returned `["beforeSub"]` and the
inherited hook simply never ran - silently, with no error, even though
`Sub.beforeBase` is a live function. A shared base middleware class (the normal
way to share an auth or audit hook) was therefore dead code in Node. Python
returns `['before_base', 'before_sub']` and Ruby `[:before_base, :before_sub]`;
Node was the only one of the four that lost hooks.

Discovery now walks the prototype chain and runs BASE-class hooks first, then
each derived class's own, de-duping an override to its first (base) position -
the same semantics as Python's `_discover_methods` (`reversed(__mro__)` over
`__dict__`) and Ruby's `discover_methods` (`ancestors.reverse_each`).
Within a class, source-declaration order is unchanged.


### Changed

- **Breaking: `Messenger.inbox()` takes the folder FIRST.** The signature is now
  `inbox(folder = "INBOX", limit = 20, offset = 0)`, matching the Python master
  (`inbox(folder="INBOX", limit=20, offset=0)`), PHP (`inbox($folder, $limit, $offset)`)
  and Ruby (`inbox(folder:, limit:, offset:)`). Node was the sole outlier at
  `inbox(limit, offset, folder)`, and because it is positional-only, the same
  positional call meant something different in Node than in every other language.

  Migration -- move the folder to the front:

  ```ts
  // before
  const archived = await messenger.inbox(20, 0, "Archive");
  // after
  const archived = await messenger.inbox("Archive", 20, 0);
  ```

  `inbox()` with no arguments is unchanged, which is the common call. A
  TypeScript caller passing the old form gets a compile error (`TS2345:
  Argument of type 'number' is not assignable to parameter of type 'string'`),
  so the break surfaces at build time rather than as a silently-wrong folder at
  runtime. Plain-JavaScript callers get no such warning -- grep for `.inbox(`
  before upgrading.

- **Breaking: `Messenger.read()` returns `null` for a UID that does not exist.**
  It previously returned a fully-shaped-but-blank `ImapFullMessage` (the uid
  echoed back, every other field `""`), under a comment claiming "parity with
  Python's `{}`". That object is TRUTHY, whereas Python's `{}`, PHP's `null` and
  Ruby's `nil` are all falsy -- so Node was the one framework where
  `if (!message)` could not distinguish "no such message" from a real one, and a
  caller had to inspect individual fields to find out. A missing UID is still
  NOT an error and still does not throw; the return type is now
  `Promise<ImapFullMessage | null>`.

  Migration -- null-check the result:

  ```ts
  // before
  const message = await messenger.read(uid);
  if (!message.subject) { /* might be missing, might be a blank subject */ }
  // after
  const message = await messenger.read(uid);
  if (!message) { /* definitively no such UID */ }
  ```

  TypeScript flags every unchecked property access on the result
  (`TS18047: 'message' is possibly 'null'`), so the break is caught at build
  time. The now-unreachable `emptyFullMessage()` helper is deleted.

- **Breaking: `QueryBuilder.get()` returns a `DatabaseResult`, not a bare array.** All
  three other frameworks return the `DatabaseResult` that `db.fetch()` produces (Python
  `orm/query_builder/__init__.py`, PHP `QueryBuilder::get()`, Ruby `QueryBuilder#get`).
  Node returned a plain array, so the same builder chain produced a different type per
  language and portable code could not read `.records`, `.count`, `.limit` or `.offset`.

  Migration -- read `.records` for the rows:

  ```ts
  // before
  const rows = await User.query().where("age > ?", [28]).get();
  rows.length;
  // after
  const result = await User.query().where("age > ?", [28]).get();
  result.records.length;
  ```

  `DatabaseResult` is iterable, so `for (const row of result)` and `[...result]` keep
  working unchanged, and `response()` / `res.json()` already auto-serialize it to a JSON
  array -- a route returning `.get()` directly needs no change at all. Only code that
  called an Array method (`.length`, `.map`, `.filter`) on the result must move to
  `.records`. The no-default-LIMIT behaviour from v3.13.39 is unchanged.

- **Breaking: `Model.all()` no longer takes a `where`/`params` filter.** The signature
  is now `all(limit = 100, offset = 0, include?, orderBy?)`, matching the Python master,
  PHP and Ruby. Node was the sole outlier of the four: its extra leading `where`/`params`
  shifted every following argument, so the same positional call meant different things
  in different languages.

  Migration -- a filtered read moves to `where()`, which already exists and takes the
  conditions first:

  ```ts
  // before
  const adults = await User.all("age > ?", [28]);
  // after
  const adults = await User.where("age > ?", [28]);
  ```

  `all()` with no arguments is unchanged, which is the overwhelmingly common call. A
  TypeScript caller passing the old form gets a compile error (`TS2345: Argument of type
  'string' is not assignable to parameter of type 'number'`), so the break surfaces at
  build time rather than as malformed SQL at runtime. Plain-JavaScript callers get no
  such warning -- grep for `.all("` before upgrading.

- **Breaking: the metrics payload is now the native engine's shape.** `fullAnalysis` no
  longer returns a `violations` key. The ranked `offenders` list replaces it and
  `--fail-on` reads that same list, so one concept has one name instead of two.
  Verified before removal: zero consumers outside the tests.

- **Breaking: `fileDetail` returns the engine's per-file shape.** It no longer returns
  `total_lines`, `classes`, `imports` or `warnings`, and `functions` is now a COUNT rather
  than a list. Anything reading those keys must move to the engine's fields, or call
  `fullAnalysis` and read `most_complex_functions` for per-function detail.

- **Breaking: the empty-class warning is gone and is not coming back.** The old
  hand-rolled analyzer flagged `class Foo {}` with no members. An empty class is usually
  CORRECT rather than a defect: marker classes, base exception types, DTO placeholders.
  Tina4 itself ships `MetricsEngineError` as exactly that, so the check flagged the
  framework's own correct code. A check that fires on correct code is noise, and noise is
  why the offenders list went unread for months. The engine's vocabulary stays the four
  things that are actionable: complexity, large file, low maintainability, untested.

- **Breaking: the column-metadata primary-key flag is `primaryKey`.** Node and PHP use `primaryKey`; Python and Ruby use `primary_key`. Each follows its own
  language's paradigm because this is framework API surface, not data. The COLUMN NAME
  itself is unaffected and still mirrors the database verbatim.

- **Breaking: metrics REQUIRE the `tina4` CLI on PATH, with no fallback.** All four
  frameworks deleted their own hand-rolled analyzer, so `fullAnalysis`, `offenders` and
  `fileDetail` now shell out to `tina4 metrics --json` (ADR-0002: one engine, so a number
  measured in one language is comparable with the same number measured in another). A
  missing or stale CLI raises and names the install command instead of quietly returning
  worse numbers; the dev-admin endpoints answer 503, or 404 for an unknown file path.
  Previously a failure fell back to the local analyzer, which is exactly how four
  frameworks came to disagree about the same file. The file census behind the dashboard
  (`quick_metrics`) stays in-process and needs no CLI: it is a glob-and-count, and the
  engine is 8x to 37x slower on that path.

- **Breaking: every ORM read path that takes a `limit` now defaults to 100 rows, and
  four of them had no cap at all.** `db.fetch()`, `all()`, `select()` and `withTrashed()`
  took an optional `limit` with NO default, and the adapters only append a `LIMIT` clause
  when one is given, so each returned every row. `where()`, `cached()` and a
  `scope()`-generated method defaulted to 20. All seven now default to 100
  (`DEFAULT_ROW_CAP`, exported from `@tina4/orm` so the ORM and the DB layer cannot drift
  apart on the number).

  Migration: this one can change results in both directions. A caller relying (knowingly
  or not) on an unbounded read must now ask for it: `Model.where(sql, [], 10000)`. A
  caller relying on the old 20 gets 100. Code that already passes a limit is unaffected.
  `all()` and `select()` gained `limit`/`offset` parameters, appended after the existing
  ones, so positional callers keep working.

  `QueryBuilder.get()` and `db.fetchAll()` are deliberately UNCHANGED and stay uncapped.
  Neither takes a `limit`, so a cap there can only ever be silent, and that silent
  `LIMIT 100` was the data-loss-on-read footgun removed in 3.13.39. `fetchAll` needed a
  structural change to keep that promise: Node's adapters read `limit: 0` as `LIMIT 0`
  (zero rows) rather than as the "no truncation" sentinel Python and PHP use, so the cap
  could not live on `fetch`'s parameter default without `fetchAll()` silently inheriting
  it. Both now share one internal body; `fetch` applies the cap, `fetchAll` passes the
  limit through untouched.

- Internal: the SQL dialect-translation module is renamed
  `packages/orm/src/sqlTranslation.ts` -> `packages/orm/src/sqlTranslator.ts`, so the filename
  matches the `SQLTranslator` class it exports (and the sibling frameworks). Consumers import the
  class by name from the package barrel (`export { SQLTranslator, QueryCache }`), and no exports
  map ever pointed at the file path, so this is a filename alignment with no API change.

### Fixed

- **`tina4 deploy docker` produced images that could not start.** Of the eight
  Dockerfile generators in the stack (four templates in the `tina4` CLI plus one
  in each framework's own CLI), exactly one was correct. Python named
  `python -m tina4_python.cli`, a package with no `__main__.py`, so the container
  died on startup; PHP ran `php index.php <addr>`, but `App::run(?host, port)`
  never reads argv so the address was dropped and production never engaged;
  Node named a path that exists only inside the tina4-nodejs monorepo and
  depended on tsx, which `npm ci --omit=dev` strips. Every generator now names a
  published entry point and requests production. Verified by scaffolding,
  generating, building and running a container for all four languages.
- **`serve` no longer kills PID 1.** The port-reclaim step read `lsof -ti`
  without validating it. Where lsof prints a different shape, a non-numeric field
  coerced to 0 or 1 -- and signalling PID 0 hits every process in the caller's
  own process group. In a container the server IS PID 1, so it killed itself
  (Node logged "Killed existing process on port 7148 (PID: 1 ...)" then exited
  143; PHP logged the same attempt and survived by luck). Reclaiming is now
  skipped inside a container, only all-digit PIDs are accepted, and PID 0, PID 1
  and the current process are never signalled.
- **The npm package ships built JavaScript.** `bin` pointed at a shell script
  running `npx tsx src/bin.ts`, and the package published TypeScript sources
  only -- so a production container had to fetch tsx from the network at start.
  `bin` is now `packages/cli/dist/bin.js`, a self-contained bundle importing only
  Node built-ins; `prepublishOnly` guarantees dist/ is in the tarball and
  `prepare` builds it in a fresh checkout. Verified with `--network none`.
