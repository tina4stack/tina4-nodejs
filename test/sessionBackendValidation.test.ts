/**
 * Tests for TINA4_SESSION_BACKEND name validation.
 *
 * An unrecognised session backend name must THROW, not silently become `file`.
 *
 * The bug these lock in: the handler switch ended in `case "file": default:`, so
 * any name Node did not recognise wrote sessions to local disk. Node also did no
 * normalisation at all, so a plain capital from a .env line ("Redis") was already
 * "unrecognised" and silently became file while Python and Ruby resolved it. Both
 * produced a running app with sessions on the wrong storage, nothing logged and
 * nothing failed; the symptom arrived much later, as users being logged out
 * whenever a request landed on another instance.
 *
 * NO MOCKS and no dependency: every case here is the pure name -> outcome
 * decision, asserted through the real Session constructor. Nothing is stubbed,
 * and the cases that would need a live backend deliberately assert only that the
 * name is not REJECTED, rather than opening a connection.
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_session_backend_validation.py
 *   tina4-php/tests/SessionBackendValidationTest.php
 *   tina4-ruby/spec/session_backend_validation_spec.rb
 */
import {
  CANONICAL_SESSION_BACKENDS,
  Session,
  VALID_SESSION_BACKENDS,
} from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/** Run fn and return the thrown error, or null if it did not throw. */
function caught(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err as Error;
  }
}

const previousBackend = process.env.TINA4_SESSION_BACKEND;
function withBackend<T>(value: string | undefined, fn: () => T): T {
  if (value === undefined) delete process.env.TINA4_SESSION_BACKEND;
  else process.env.TINA4_SESSION_BACKEND = value;
  try {
    return fn();
  } finally {
    if (previousBackend === undefined) delete process.env.TINA4_SESSION_BACKEND;
    else process.env.TINA4_SESSION_BACKEND = previousBackend;
  }
}

console.log("=== Session Backend Validation ===\n");

// ── 1. NEGATIVE: the actual bug ───────────────────────────────────

{
  const err = withBackend("redsi", () => caught(() => new Session()));

  assert(
    "an unknown session backend raises instead of silently using file",
    err !== null,
    "constructed silently - it would be writing FILE sessions",
  );
  assert(
    "the error says the backend is unknown",
    err !== null && /Unknown session backend/.test(err.message),
    err?.message ?? "",
  );
}

// ── 2. The message has to be actionable ───────────────────────────

{
  const err = withBackend("postgres", () => caught(() => new Session()));

  assert(
    "the error names the unknown backend",
    err !== null && err.message.includes("postgres"),
    `the operator cannot see which value was wrong: ${err?.message ?? ""}`,
  );
  for (const canonical of CANONICAL_SESSION_BACKENDS) {
    assert(
      `the error offers "${canonical}"`,
      err !== null && err.message.includes(canonical),
      err?.message ?? "",
    );
  }
}

// ── 3. POSITIVE: the documented default must survive ──────────────

{
  const err = withBackend(undefined, () => caught(() => new Session()));
  assert("an unset backend still defaults to file", err === null, err?.message ?? "");
}

// ── 4. POSITIVE, and the subtle one ───────────────────────────────
//
// An env var set to "" is a SET variable, so it never reaches the `??` default.
// Treating blank as an unknown name would break every deployment that clears the
// var to take the default.

for (const blank of ["", "   "]) {
  const err = withBackend(blank, () => caught(() => new Session()));
  assert(
    `a blank backend (${JSON.stringify(blank)}) still defaults to file`,
    err === null,
    err?.message ?? "",
  );
}

// ── 5. Normalisation: a .env line carries capitals and spaces ─────
//
// This is the case Node alone used to fail. Python and Ruby normalised; Node did
// not, so "Redis" silently became file HERE while resolving correctly there.

for (const spelling of ["FILE", " file ", "FileSystem", "\tfilesystem\n"]) {
  const err = withBackend(spelling, () => caught(() => new Session()));
  assert(
    `a backend name is case and whitespace insensitive (${JSON.stringify(spelling)})`,
    err === null,
    err?.message ?? "",
  );
}

// ── 6. POSITIVE: a valid name must never be swallowed ─────────────
//
// Only the NAME decision is asserted. Constructing redis/mongo/database reaches
// for a real service, and this case is about validation, so a backend that fails
// to CONNECT still counts as accepted - what must never happen is the
// "Unknown session backend" rejection.

for (const name of VALID_SESSION_BACKENDS) {
  const err = withBackend(name, () => caught(() => new Session()));
  assert(
    `every documented backend name is accepted (${name})`,
    err === null || !/Unknown session backend/.test(err.message),
    `${name} is in VALID_SESSION_BACKENDS but the dispatch rejected it`,
  );
}

// ── 7. The offered names must themselves be valid ─────────────────

for (const canonical of CANONICAL_SESSION_BACKENDS) {
  assert(
    `the canonical name "${canonical}" is itself valid`,
    (VALID_SESSION_BACKENDS as readonly string[]).includes(canonical),
    "the error message would be offering an invalid value",
  );
}

// ── 8. A RETIRED name keeps its specific migration message ────────
//
// `redis-npm` is not in VALID_SESSION_BACKENDS, so the generic unknown-name check
// would happily reject it - with a message that never mentions what replaced it.
// The operator had a WORKING config; telling them the replacement is the point.

{
  const err = withBackend("redis-npm", () => caught(() => new Session()));

  assert("a retired backend name still throws", err !== null, "constructed silently");
  // NEGATIVE: the generic message must NOT win here.
  assert(
    "a retired name does NOT fall back to the generic unknown-backend message",
    err !== null && !/Unknown session backend/.test(err.message),
    err?.message ?? "",
  );
  assert(
    "the retired-name error names the replacement backend",
    err !== null && /"redis"/.test(err.message),
    err?.message ?? "",
  );
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
