# Feature: Agent Experience — Import-hint fallback + Generate resolution transparency

Two AI-agent-experience features targeting 3.13.117. Both make wrong guesses
fail LOUD with the right hint, and make deterministic scaffolding decisions
visible on stdout as a stable JSON envelope for tools that call the CLI.

Reference:
- Python master's `SQL_RESERVED_TABLE_NAMES` at
  `tina4-python/tina4_python/cli/__init__.py:57-95`.
- ADR-0062 forthcoming (documents the Node parity gap on Feature A).

## Outcome

- `import { X } from "@tina4/core/<typo>"` under Node fails with a helpful error
  naming REAL subpaths from `@tina4/core`'s own exports map, instead of the
  bare `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- `tina4nodejs generate model Order --json` emits a stable resolution envelope
  on STDOUT documenting every transformation (e.g. `order` → `orders` because
  `order` is a SQL reserved word). `--dry-run` writes nothing.
- Bare `tina4nodejs generate model Order` still writes files, but prints the
  same resolution as a human block to STDERR before writing.
- `commands --json` gains `resolution_contract: { version: "1",
  envelope: "generate_v1" }` so the tina4 client can discover this contract.

## Node parity gap (accepted, documented in ADR-0062)

Node's ESM resolver invokes the wildcard target with the RESOLVED file path,
not the ORIGINAL requested subpath — so the wildcard's `_missing.ts` cannot
know what the caller typed. The message therefore lists all real subpaths
generically ("no such subpath. Real subpaths: router, api, auth, ..."), where
Python/PHP/Ruby can add a direct "did you mean X?" pointed at the closest
match. The browsable list is strong enough for an agent; the asymmetry is
called out in the JSDoc on top of `_missing.ts`.

## Scope

### Feature A — Import-hint fallback on `@tina4/core`

- [x] Add specific subpath exports to `packages/core/package.json` for the
      common modules (each points at `./dist/index.js` — the bundle re-exports
      everything from every module).
- [x] Add `"./*": "./dist/_missing.js"` LAST in the exports map.
- [x] Write `packages/core/src/_missing.ts` that at import time reads its own
      sibling `package.json`, filters out `.` and `./*`, and throws a helpful
      Error naming the real subpaths.
- [x] Update `packages/core/package.json`'s `build` script to also emit
      `dist/_missing.js` alongside `dist/index.js`.
- [x] Bandwidth-permitting: same pattern on `@tina4/orm`, `@tina4/swagger`,
      `@tina4/frond` — decision recorded here.

### Feature B — Generate resolution transparency

- [x] Introduce `SQL_RESERVED_TABLE_NAMES` set + `pluralizeReserved(name)`
      helper in `packages/cli/src/commands/generate.ts` (mirrors Python master).
- [x] Extend `toTableName(name)` to auto-pluralize reserved words and RECORD
      the transformation on a per-run resolution object.
- [x] Add `--json` and `--dry-run` flags on `generate <model|route|migration|middleware>`.
- [x] Print resolution envelope (JSON on stdout for `--json`; human block on
      stderr otherwise) BEFORE files are written.
- [x] `commands --json` gains `resolution_contract: { version: "1",
      envelope: "generate_v1" }`.

## Tests (real subprocess, no mocks)

### `test/importHint.test.ts`

- [x] positive-happy: `import { get } from "@tina4/core/router"` — get is a function
- [x] negative-hint: `import x from "@tina4/core/route"` — non-zero exit, stderr
      contains "no such subpath" AND names at least 3 real subpaths
- [x] negative-no-match: `import x from "@tina4/core/zzzzz"` — same behavior
- [x] masking-gate: an ephemeral fixture subpath whose own body imports a
      missing package raises the ORIGINAL `ERR_MODULE_NOT_FOUND`, NOT the
      wildcard hint (cleanup restores the tree in `finally`)
- [x] tsc: `npm run typecheck` still exits 0 with the new exports
- [x] mutation-gate: revert the wildcard, rerun negative-hint, expect the bare
      `ERR_PACKAGE_PATH_NOT_EXPORTED` — restore and re-verify the hint

### `test/generateResolution.test.ts`

- [x] envelope-shape: `generate model Order --json --dry-run` prints a valid
      envelope with all required top-level keys; `dry_run: true`;
      `actions_taken: []`; correct class_name, table_name, file_path
- [x] reserved-word: `generate model Order --json --dry-run` records a
      `reserved_word_pluralize` transformation (`order` → `orders`)
- [x] not-reserved: `generate model Product --json --dry-run` records NO
      transformations (product is not reserved)
- [x] dry-run-no-writes: `generate model Order --json --dry-run` writes NOTHING
      to disk (real mkdtemp dir stays empty after run)
- [x] human-writes: bare `generate model Order` (no --json) writes files AND
      prints the resolution block to stderr

## Bugs

- [x] `generate auth` scaffold hard-coded `FROM user`; with Feature B, `user`
      is a reserved word so the model's tableName is now `users` and the auth
      route's SQL 500'd. Fixed the two literals in `packages/cli/src/commands/generate.ts`
      to `FROM users`. `cliGenerateCoemits.test.ts` passes 38/38.
- [x] `test/cli.test.ts` asserted `toTableName("User") === "user"` — that was
      the OLD behaviour. Updated to reflect the new reserved-word policy:
      `toTableName("User") === "users"` and added a plain-word gate
      (`toTableName("Product") === "product"`) so regressions are caught both
      ways.

## Commits

- (hash description — one line per landed change; recorded on push below)

## Status: In Progress
