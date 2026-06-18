/**
 * Lock-in tests for the Session backend-failure policy: log-loud + degrade.
 * Run with: npx tsx test/sessionBackendFailure.test.ts
 *
 * Contract (parity across all 4 frameworks): when a session backend
 * (Redis/Valkey/Mongo/Database) becomes unreachable mid-request, the framework
 * must LOG LOUDLY and DEGRADE — never silently lose data, and never let one
 * backend blip 500 every request (cascade outage). The default is:
 *
 *   * read failure    -> log an error, return an empty session (request still serves)
 *   * write failure   -> log an error, best-effort (dirty flag retained for retry)
 *   * destroy/gc fail  -> log an error, swallow
 *
 * A GENUINELY EMPTY result (no such session yet) is NOT a failure — the handler
 * returns null WITHOUT throwing, so it must never be logged as an error.
 *
 * `TINA4_SESSION_STRICT=true` flips this to re-raise (the escape hatch that
 * mirrors the `strict` flag on events/seeding).
 *
 * These mirror the 5 Python invariants in
 * tina4-python/tests/test_session_backend_failure.py (commit cefc738) plus the
 * new "transport failure now LOGS (no longer silent)" assertion.
 */
import { Session } from "../packages/core/src/session.ts";
import type { SessionHandler } from "../packages/core/src/session.ts";
import { Log } from "../packages/core/src/logger.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

interface SessionData {
  _created: number;
  _accessed: number;
  [key: string]: unknown;
}

/**
 * A backend that throws on every operation — simulates an unreachable
 * Redis/Valkey/Mongo/DB mid-request.
 */
class ExplodingHandler implements SessionHandler {
  read(_id: string): SessionData | null {
    throw new Error("backend unreachable");
  }
  write(_id: string, _data: SessionData, _ttl?: number): void {
    throw new Error("backend unreachable");
  }
  destroy(_id: string): void {
    throw new Error("backend unreachable");
  }
  gc(_maxLifetime?: number): void {
    throw new Error("backend unreachable");
  }
}

/**
 * A handler that reads cleanly and lets the first write (start()'s fresh-session
 * bootstrap) succeed, then fails on every subsequent write — lets us drive the
 * strict-write path on save() without start()'s bootstrap write throwing first.
 * (Node's start() persists a fresh empty session, unlike Python's read-only
 * start(); this isolates the save() write-failure under strict.)
 */
class WriteFailsAfterStartHandler implements SessionHandler {
  public writes = 0;
  read(_id: string): SessionData | null {
    return null; // healthy, no session yet
  }
  write(_id: string, _data: SessionData, _ttl?: number): void {
    this.writes++;
    if (this.writes > 1) throw new Error("backend unreachable");
  }
  destroy(_id: string): void {
    throw new Error("backend unreachable");
  }
}

/**
 * A healthy backend that simply has no data for this session — returns null
 * WITHOUT throwing. This is the normal "no session yet" case and must never be
 * treated as a backend error.
 */
class EmptyHandler implements SessionHandler {
  public reads = 0;
  read(_id: string): SessionData | null {
    this.reads++;
    return null;
  }
  write(_id: string, _data: SessionData, _ttl?: number): void {
    /* succeeds, no-op */
  }
  destroy(_id: string): void {
    /* succeeds, no-op */
  }
}

/**
 * Capture Log.error calls so we can assert the failure was logged (never
 * silent). Returns a restore() fn and the captured-messages array.
 */
function captureErrors(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = Log.error;
  Log.error = ((message: string, _data?: unknown) => {
    errors.push(message);
  }) as typeof Log.error;
  return { errors, restore: () => { Log.error = original; } };
}

console.log("=== Session Backend-Failure Policy Tests ===\n");

// ── default policy: log-loud + degrade ───────────────────────────────────────

console.log("-- Default policy: log-loud + degrade --");

// Invariant 1: unreachable backend on start() does NOT raise; returns an id,
// empty data, AND logs an error (never silent).
{
  delete process.env.TINA4_SESSION_STRICT;
  const cap = captureErrors();
  const session = new Session();
  session.setHandler(new ExplodingHandler());
  let threw = false;
  let sid = "";
  try {
    sid = session.start("sess-1");
  } catch {
    threw = true;
  }
  cap.restore();
  assert("start() on unreachable backend does NOT throw", !threw);
  assert("start() still issues a session id", typeof sid === "string" && sid.length > 0);
  assert("start() degrades to empty data (not crashed)", Object.keys(session.all()).length === 0);
  assert(
    "read failure is LOGGED (never silent)",
    cap.errors.some((e) => e.includes("read") && e.includes("failed")),
  );
}

// Invariant 2: save() on an unreachable backend returns false, retains the
// dirty flag (so a later save retries), logs an error, does not crash.
{
  delete process.env.TINA4_SESSION_STRICT;
  const cap = captureErrors();
  const session = new Session();
  session.setHandler(new ExplodingHandler());
  session.start("sess-2");          // read failed + logged, degraded to empty
  const errorsBeforeSet = cap.errors.length;
  session.set("user_id", 7);         // set() calls save() internally -> write fails
  const result = session.save();     // explicit re-save -> still false, retried
  cap.restore();
  assert("save() on unreachable backend returns false", result === false);
  assert(
    "write failure is LOGGED (never silent)",
    cap.errors.slice(errorsBeforeSet).some((e) => e.includes("write") && e.includes("failed")),
  );
  // dirty retained -> a write was re-attempted on the explicit save() (it logged again)
  assert(
    "dirty flag retained for retry (save re-attempts the write)",
    cap.errors.filter((e) => e.includes("write") && e.includes("failed")).length >= 2,
  );
}

// Invariant 3a: destroy() on an unreachable backend logs but never raises.
{
  delete process.env.TINA4_SESSION_STRICT;
  const cap = captureErrors();
  const session = new Session();
  session.setHandler(new ExplodingHandler());
  session.start("sess-3");
  let threw = false;
  try {
    session.destroy();
  } catch {
    threw = true;
  }
  cap.restore();
  assert("destroy() on unreachable backend does NOT throw", !threw);
  assert(
    "destroy failure is LOGGED (never silent)",
    cap.errors.some((e) => e.includes("destroy") && e.includes("failed")),
  );
}

// Invariant 3b: gc() on an unreachable backend logs but never raises.
{
  delete process.env.TINA4_SESSION_STRICT;
  const cap = captureErrors();
  const session = new Session();
  session.setHandler(new ExplodingHandler());
  let threw = false;
  try {
    session.gc();
  } catch {
    threw = true;
  }
  cap.restore();
  assert("gc() on unreachable backend does NOT throw", !threw);
  assert(
    "gc failure is LOGGED (never silent)",
    cap.errors.some((e) => e.includes("gc") && e.includes("failed")),
  );
}

// ── Invariant 4: empty-but-healthy backend logs ZERO errors ──────────────────

console.log("\n-- Empty-but-healthy backend is NOT a failure --");

{
  delete process.env.TINA4_SESSION_STRICT;
  const cap = captureErrors();
  const handler = new EmptyHandler();
  const session = new Session();
  session.setHandler(handler);
  session.start("brand-new");
  const allEmpty = Object.keys(session.all()).length === 0;
  cap.restore();
  assert("empty healthy backend yields empty session", allEmpty);
  assert("empty healthy backend read was attempted", handler.reads === 1);
  assert(
    "empty (but successful) read logs ZERO errors",
    cap.errors.length === 0,
  );
}

// ── Invariant 5: strict mode re-raises ───────────────────────────────────────

console.log("\n-- Strict mode (TINA4_SESSION_STRICT=true) re-raises --");

// 5a: read failure re-raises under strict.
{
  process.env.TINA4_SESSION_STRICT = "true";
  const cap = captureErrors();
  const session = new Session();          // reads strict flag in ctor
  session.setHandler(new ExplodingHandler());
  let threw = false;
  try {
    session.start("sess-strict");
  } catch {
    threw = true;
  }
  cap.restore();
  assert("strict mode re-raises a read failure", threw);
}

// 5b: write failure re-raises under strict. Use a handler whose first write
// (start()'s fresh-session bootstrap) succeeds, so the throw isolates to save().
{
  process.env.TINA4_SESSION_STRICT = "true";
  const cap = captureErrors();
  const session = new Session();
  session.setHandler(new WriteFailsAfterStartHandler());
  session.start("sess-strict-w");          // read null + bootstrap write succeed
  let threw = false;
  try {
    session.set("k", "v");                 // set() -> save() -> write throws
  } catch {
    threw = true;
  }
  cap.restore();
  assert("strict mode re-raises a write failure", threw);
}

delete process.env.TINA4_SESSION_STRICT;

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
