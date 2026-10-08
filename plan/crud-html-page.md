# Feature: Crud.toCrud HTML admin page (ADR-0094) — Node port

Outcome: `Crud.toCrud(request, options): Promise<string>` renders a server-rendered
CRUD admin UI (searchable, sortable, paginated table + create/edit/delete modals) for an
ORM model. It owns NO backend routes — the REST backend is 100% AutoCrud. UI comes from
four app-overridable Frond templates (crud/page|table|form|modals). AutoCrud list gains
?search + ?sort/?sort_dir. CLI `generate crud` scaffolds an AutoCrud-backed /admin/<table>
page, secure by default. Mirrors the Ruby MASTER idiomatically (camelCase, Promise<string>).

## Scope
- [ ] Export canonical escapeHtml from @tina4/frond (reuse engine htmlEscape)
- [ ] AutoCrud list: ?search (LIKE across string/text cols, filtered total) + ?sort_dir (query.ts + autoCrud.ts)
- [ ] Export resolveField/resolveFieldColumn from @tina4/orm index
- [ ] packages/core/src/crud.ts — Crud.toCrud (async), generateTable/generateForm (sync), registerBackend
- [ ] Templates packages/core/templates/crud/{page,table,form,modals}.twig (app override via src/templates/crud/)
- [ ] Export Crud (+ CRUD alias) from @tina4/core index
- [ ] CLI `generate crud <Model>` — AutoCrud-backed /admin/<table> page (secure by default; --public opens), copy crud/* templates, gate test
- [ ] Alignment by field type; live debounced AJAX search w/ AbortController, no button; inline validation errors; ZERO inline style=/on*=; one nonce'd <script>

## Tests (written first, real — no mocks)
- [ ] test/crud.test.ts — real SQLite, real model, toCrud renders page/rows/modals/search/pagination/sort links; routes registered (5 AutoCrud); idempotent; sql listing; generateTable/generateForm; model required
- [ ] test/crudCsp.test.ts — ZERO on*=/style= (regex, mutation-proven); data-crud-action wiring; nonce'd script; app template override
- [ ] test/autoCrudSearchSort.test.ts — real SQLite: ?search filters + filtered total; ?sort/?sort_dir order
- [ ] test/cliGenerateCrud.test.ts — generated admin route source + copied templates + gate test posture
- [ ] npm run typecheck exit 0

## Scope — all done
- [x] Export canonical escapeHtml from @tina4/frond
- [x] AutoCrud list ?search + ?sort_dir (query.ts + autoCrud.ts)
- [x] Export resolveField/resolveFieldColumn from @tina4/orm
- [x] packages/core/src/crud.ts — toCrud (async) + generateTable/generateForm (sync) + registerBackend
- [x] Templates packages/core/templates/crud/{page,table,form,modals}.twig (app override)
- [x] Export Crud (+ CRUD) from @tina4/core
- [x] CLI generate crud — AutoCrud-backed /admin/<table> page, secure default, copy templates, gate test
- [x] Alignment by type; live AbortController search no button; inline errors; ZERO on*=/style=; one nonce'd script

## Tests — all green (TINA4_SECRET set, lab-like)
- [x] test/crud.test.ts (38) · test/crudCsp.test.ts (14, mutation-proven) · test/autoCrudSearchSort.test.ts (9) · test/cliGenerateCrud.test.ts (21)
- [x] updated test/generateCrudPluralisation.test.ts (16), test/cliGenerateCoemits.test.ts (38), test/cli.test.ts (102) to the ADR-0094 contract
- [x] npm run typecheck exit 0

## Bugs
- [x] Generated gate-test secret was 11 bytes (< 32 HMAC min) — also in the shared generateTest template; fixed to a 44-byte test secret (made pre-existing route/auth coemit cases pass too)

## Commits
- (hash  port Crud.toCrud + AutoCrud search/sort + generate crud, ADR-0094)

## Status: Complete
