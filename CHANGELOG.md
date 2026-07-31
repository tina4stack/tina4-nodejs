# Changelog

Tina4 keeps ONE version across all four frameworks (Python, PHP, Ruby, Node.js), so a version
number means the same thing everywhere.

**The authoritative release notes for every shipped version live in the documentation:**
https://tina4.com/nodejs/36-releases

This file is deliberately NOT a copy of those notes. Duplicating them is exactly how a
changelog rots into claiming a version that was never cut, so this file records only
UNRELEASED work. When a version ships, its notes go to the release notes above.

## Unreleased

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


### Breaking: a middleware CLASS attached per-route now RUNS

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
