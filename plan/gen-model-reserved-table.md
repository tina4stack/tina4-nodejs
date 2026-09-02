# Task: Port issue-#123 `generate model` reserved-table fix to tina4-nodejs

Outcome: `tina4nodejs generate model Order` no longer SILENTLY renames the reserved-word
table `order` -> `orders`. It still pluralises (the safe choice — Tina4 interpolates table
names UNQUOTED, so `CREATE TABLE order` is a syntax error), but SAYS SO out loud, and
`--table-name <name>` lets the developer force their own name. No ORM quoting change
(identifier quoting is a global storage invariant — decided against, footgun stays shut).

Python master: `feature/release3.13.129`, commit b5d8384. Mirror `_resolve_table`,
`_to_table`, `_pluralize_table`, `SQL_RESERVED_TABLE_NAMES`, `_gen_model` +
`tests/test_gen_model_reserved_table.py`.

## Scope
- [x] Read Python master (`_resolve_table`, `_to_table`, `_pluralize_table`, `_gen_model`) + its test
- [x] Map Node's existing helpers (`toTableName`/`pluralizeReserved`/`SQL_RESERVED_TABLE_NAMES` in packages/cli/src/commands/generate.ts)
- [x] Add `resolveTable(name, flags, { announce = false })` — honours `--table-name`, prints NOTE/WARNING when announcing
- [x] Route every generator's table derivation through `resolveTable` (model announce=true; route/crud/migration/seeder/form/view announce=false)
- [x] Advertise `--table-name <name>` in `generate model` usage (GENERATORS.model.usage) + generate() options help
- [x] Confirm arg parser accepts `--table-name <value>` (already a value flag; lock in with a test)
- [x] Add test/generateModelReservedTable.test.ts (pure resolver + end-to-end subprocess, no mocks)
- [x] Run new test + `npm run typecheck` + full cli/generate suite green, no new skips

## Parity
| Feature | Python | PHP | Ruby | Node |
|---------|--------|-----|------|------|
| resolveTable + --table-name + note-not-silent | ✅ (master) | (n/a this task) | (n/a this task) | ✅ |

Scope of THIS task = Node only (Python already shipped; PHP/Ruby tracked separately).

## Tests (written real, no mocks, positive + negative)
- [x] pure: non-reserved -> singular, silent (Product -> product)
- [x] pure: reserved -> plural + NOTE when announcing (Order -> orders, note names --table-name)
- [x] pure: reserved -> plural + SILENT when not announcing
- [x] pure: `--table-name customer_orders` wins verbatim, no warning
- [x] pure: `--table-name select` (reserved) forced -> WARNING (UNQUOTED) + obeyed
- [x] pure: bare `--table-name` (true) ignored -> falls back to orders
- [x] pure: parseCliArgs accepts `--table-name <value>`
- [x] e2e: `generate model Order` writes tableName "orders" + prints note (real temp dir, read file back)
- [x] e2e: `generate model Order --table-name my_orders` writes tableName "my_orders"

## Bugs
- (none found; the existing envelope `--table … --quote` transformation string is left UNCHANGED,
  exactly as the Python master left its equivalent — the fix ADDS the announce-path, it does not
  touch the envelope transformation)

## Commits
- (hash on landing)  generate.ts: add resolveTable(name, flags, {announce}); route model/route/crud/
  migration/seeder/form/view through it; advertise --table-name in model usage/help. New test
  generateModelReservedTable.test.ts. Verified macOS, Node (local): typecheck clean; new 23/0;
  cli 101/0, generateResolution 48/0, generateEnvelopeV11 79/0, cliGenerateCoemits 38/0,
  mcpMigrationCreateEnvelope 49/0, twigSqlEditHints 53/0, commandsManifest 31/0,
  migrateCreateEnvelopeParity 42/0, cliVersionSync 3/0, createTableCallableDefault 5/0.
  Mutation-proven: override-ignored -> 5 red; note-suppressed -> 3 red.

## Status: Complete
