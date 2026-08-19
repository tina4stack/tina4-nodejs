# Firebird migration ledger — 3.13.105

## Scope

- [x] Review PR #49 against the current `v3` source.
- [x] Confirm that the change restores the existing cross-language ledger contract.
- [x] Test the merged route-inspection and Firebird changes on the Linux lab.
- [x] Merge the accepted PR into `v3` and the isolated 3.13.105 release branch.

## Bugs

- [x] Firebird rejected the ledger DDL because `NOT NULL` preceded `DEFAULT`.
- [x] A quoted lowercase ledger name could not address the unquoted table shared with PHP and Python.
- [x] The migration runner read `NEXT_ID`, but the Firebird adapter returned `next_id`.

## Parity

The fix restores the established Tina4 migration ledger. It does not add a Node-only
contract. Firebird now reads and writes the same unquoted `TINA4_MIGRATION` table used by
the PHP and Python implementations.

## Verification

- TypeScript typecheck: passed.
- Workspace build and declaration build: passed.
- Live Firebird 5 ledger test: 3 passed, 0 failed, 0 skipped.
- Live Firebird column-case test: 2 passed, 0 failed, 0 skipped.
- Full merged Node.js suite: 8,302 passed, 0 failed, 33 skipped across 325 files.
- The first full-suite attempt ran before the package build and failed three CLI/export
  files because their generated `dist` and `types` artifacts were absent. The suite passed
  after the required build; those setup failures did not reproduce in the built tree.

## Commits

- `61b3b9a` — repair Firebird ledger creation, naming, and generated-key reads.
- `029c485` — add a live Firebird migration-ledger regression test and CI coverage.
- `3651f11` — merge PR #49 into `v3`.
- `fac49a2` — bring the merged PR into the isolated 3.13.105 Node.js branch.

## Status: Complete
