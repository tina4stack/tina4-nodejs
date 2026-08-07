/**
 * Session lifecycle parity tests (file backend, real filesystem, no mocks).
 *
 * Two cross-framework contracts, aligned to the Python master
 * (tina4_python/tina4_python/session/__init__.py):
 *
 *   1. destroy() ENDS the session — a later set()+save() with NO new start()
 *      must write NO record (the id is cleared, so there is nothing to persist
 *      under). A fresh start() mints a new id and persists normally.
 *   2. flash(key, null) is the GET sentinel — it READS-and-CLEARS the pending
 *      value and never STORES null. (Node used `value !== undefined`, so
 *      flash(key, null) STORED null; this pins the READ behaviour.)
 *
 * Run with: npx tsx test/sessionLifecycle.test.ts
 */
import { Session, FileSessionHandler } from "../packages/core/src/session.ts";
import { createHash } from "node:crypto";
import { existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TEST_PATH = "/tmp/tina4-session-lifecycle-test";

/** On-disk path of a session, mirroring FileSessionHandler.filePath(). */
const sessionFile = (id: string): string =>
  join(TEST_PATH, `${createHash("sha256").update(id).digest("hex")}.json`);

/** The set of .json session files currently on disk. */
const sessionFiles = (): string[] => {
  try {
    return readdirSync(TEST_PATH).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
};

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

// Clean slate
try { rmSync(TEST_PATH, { recursive: true }); } catch { /* ignore */ }

console.log("=== Session Lifecycle Parity Tests ===\n");

// ── destroy() must not let a later set()+save() RESURRECT the session ──

console.log("-- destroy: no resurrect --");

{
  const session = new Session("file", { path: TEST_PATH });
  const oldId = session.start();
  session.set("user_id", 42);   // set() auto-saves
  session.save();
  assert("record exists after the first write", existsSync(sessionFile(oldId)));

  // End the session: record removed, id cleared.
  session.destroy();
  assert("destroy() removes the stored record", !existsSync(sessionFile(oldId)));
  assert("destroy() clears the session id", session.getSessionId() === null);

  // A set()+save() with NO new start() must NOT resurrect anything.
  session.set("user_id", 99);
  session.save();
  assert(
    "set()+save() after destroy() creates no record",
    sessionFiles().length === 0,
  );

  // A FRESH handler reading the OLD id from the SAME backend finds NO data.
  const fresh = new FileSessionHandler(TEST_PATH);
  assert(
    "the destroyed id is not readable again (nothing re-created)",
    fresh.read(oldId) === null,
  );
}

// Negative control: destroy() is not a permanent gag — a NEW start() persists.
{
  const session = new Session("file", { path: TEST_PATH });
  const oldId = session.start();
  session.set("k", "v");
  session.save();
  session.destroy();

  const newId = session.start();
  assert("a fresh start() after destroy() mints a NEW id", newId !== oldId);
  session.set("k", "v2");
  session.save();
  const fresh = new FileSessionHandler(TEST_PATH);
  const loaded = fresh.read(newId) as Record<string, unknown> | null;
  assert(
    "the fresh session persists normally under its NEW id",
    loaded !== null && loaded.k === "v2",
  );
}

// ── flash(key, null) must READ-and-clear, not STORE null ──────────────

console.log("\n-- flash: null reads, does not store null --");

{
  const session = new Session("file", { path: TEST_PATH });
  session.start();

  session.flash("message", "Saved!");   // set (value is a real value)
  assert("flash set stores the value", session.has("_flash_message"));

  // null is the GET sentinel: read the pending value AND clear it.
  const first = session.flash("message", null);
  assert('flash(key, null) READS the pending value ("Saved!")', first === "Saved!");
  assert(
    "flash(key, null) CLEARS the key — it never STORES null",
    session.has("_flash_message") === false,
  );

  // A second read is empty — the value was consumed, not re-stored as null.
  const second = session.flash("message", null);
  assert("a second flash(key, null) read is empty", second === undefined);
}

// ── Cleanup ──────────────────────────────────────────────────────────

try { rmSync(TEST_PATH, { recursive: true }); } catch { /* ignore */ }

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
