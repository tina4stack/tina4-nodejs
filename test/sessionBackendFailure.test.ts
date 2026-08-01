/**
 * Session backend-failure policy: log-loud + degrade. NO DOUBLES.
 * Run with: npx tsx test/sessionBackendFailure.test.ts
 *
 * Contract (parity across all 4 frameworks): when a session backend
 * (Redis/Valkey/Mongo/Database) becomes unreachable mid-request, the framework
 * must LOG LOUDLY and DEGRADE -- never silently lose data, and never let one
 * backend blip 500 every request (cascade outage). The default is:
 *
 *   * read failure    -> log an error, return an empty session (request still serves)
 *   * write failure   -> log an error, best-effort (dirty flag retained for retry)
 *   * destroy/gc fail -> log an error, swallow
 *
 * A GENUINELY EMPTY result (no such session yet) is NOT a failure and must
 * never be logged as an error.
 *
 * `TINA4_SESSION_STRICT=true` flips this to re-raise.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE USED TO BE -- and why every line of it was untrustworthy.
 *
 * It declared three in-test classes implementing SessionHandler
 * (`ExplodingHandler`, `WriteFailsAfterStartHandler`, `EmptyHandler`) and
 * injected them through the real `setHandler()`. It is the exact twin of
 * tina4-python's `_ExplodingHandler`, tina4-php's `ThrowingSessionHandler` and
 * tina4-ruby's `RaisingHandler` -- the same double, ported four ways.
 *
 * A fabricated synchronous `throw new Error("backend unreachable")` is not what
 * an unreachable Redis produces. The real path runs through respClient/
 * syncSocket and surfaces ECONNREFUSED, ETIMEDOUT, or a partial RESP reply --
 * different exception types, different messages, different timing. If the
 * framework's catch were narrower than the test assumed, this file stayed green
 * while production 500'd on every request: the precise cascade outage it exists
 * to prevent.
 *
 * The `EmptyHandler` positive control was the worst of the three. It asserted
 * "an empty healthy read logs ZERO errors" against a handler that CANNOT fail,
 * so it could never catch the regression it existed for: a real server's
 * `$-1\r\n` null bulk reply being misclassified by the TRANSPORT as an error.
 * That misclassification lives in the transport, and the transport never ran.
 *
 * `captureErrors()` reassigned `Log.error` to a closure. Every "is LOGGED
 * (never silent)" claim was therefore a substring check on a function the test
 * itself installed. Log.error's real body -- level gating, TINA4_LOG_OUTPUT
 * routing, JSON structuring, the file write -- never executed, so a regression
 * that made Log.error silently drop the record in production still read PASS.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOW -- three real drivers, one real log sink, no stand-ins.
 *
 *  (1) UNREACHABLE BACKEND: the REAL RedisSessionHandler pointed at a genuinely
 *      closed port, obtained by bind-then-release. Every operation fails with a
 *      real ECONNREFUSED through the real transport. Needs no service, so it
 *      never skips.
 *  (2) EMPTY-BUT-HEALTHY: the REAL RedisSessionHandler against LIVE Redis,
 *      reading a fresh randomUUID key that genuinely does not exist -- a real
 *      `$-1\r\n` null bulk reply off the wire. Skips loudly naming host+port.
 *  (3) WRITE FAILS AFTER START: the REAL FileSessionHandler in a real temp dir.
 *      start() writes successfully, then the directory is chmod 0500 so the
 *      NEXT write takes a real EACCES from the real kernel.
 *
 *  LOGGING is measured by pointing the REAL logger at a real file
 *  (TINA4_LOG_OUTPUT=file + TINA4_LOG_DIR) and reading the bytes it actually
 *  wrote. Each scenario reads only the delta appended since it began.
 */
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real logger must be configured BEFORE it is imported anywhere, because
// every Log call re-reads the environment (logger.ts readEnv) -- but the file
// path is resolved per call, so setting it here is enough and is honest about
// what production does.
const LOG_DIR = mkdtempSync(join(tmpdir(), "tina4-sessfail-log-"));
process.env.TINA4_LOG_OUTPUT = "file";
process.env.TINA4_LOG_DIR = LOG_DIR;
process.env.TINA4_LOG_LEVEL = "DEBUG";
process.env.TINA4_LOG_FORMAT = "json";

const { Session, RedisSessionHandler, FileSessionHandler } = await import(
  "../packages/core/src/session.ts"
);
const { DatabaseSessionHandler } = await import(
  "../packages/core/src/sessionHandlers/databaseHandler.ts"
);

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
  }
}

function skip(label: string, reason: string) {
  skipped++;
  console.log(`  \x1b[33mSKIP\x1b[0m ${label}: ${reason}`);
}

const LOG_FILE = join(LOG_DIR, "tina4.log");
const REDIS_HOST = process.env.TINA4_SESSION_REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.TINA4_SESSION_REDIS_PORT ?? "6379");

/**
 * Read the bytes the REAL logger appended to the REAL log file since `from`.
 * This is the file an operator tails; nothing in this process stands between
 * Log.error and the disk.
 */
function logSince(from: number): string {
  let size = 0;
  try { size = statSync(LOG_FILE).size; } catch { return ""; }
  if (size <= from) return "";
  const buf = readFileSync(LOG_FILE);
  return buf.subarray(from, size).toString("utf-8");
}

function logSize(): number {
  try { return statSync(LOG_FILE).size; } catch { return 0; }
}

/**
 * On-disk path of a session record, mirroring `FileSessionHandler.filePath()`.
 *
 * ADR-0021 made the session id OPAQUE: the file is named for the SHA-256 hex
 * digest of the id, never the id itself. `join(dir, `${sid}.json`)` names a file
 * that has not existed since that ADR, so the chmod below took an ENOENT and
 * killed the whole process before it printed a summary line.
 */
const sessionFile = (dir: string, id: string): string =>
  join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);

/** Every ERROR-level line the real logger wrote since `from`, as objects. */
function errorLinesSince(from: number): { level: string; message: string }[] {
  return logSince(from)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((o): o is { level: string; message: string } => o !== null && o.level === "ERROR");
}

/** A port nothing is listening on, found by binding then releasing it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("=== Session backend-failure policy (REAL backends, REAL log file) ===\n");

// A REAL Redis handler pointed at a genuinely dead port. Nothing is listening,
// so the real transport really cannot connect.
const DEAD_PORT = await closedPort();
const deadRedis = () => new RedisSessionHandler({ redisHost: "127.0.0.1", redisPort: DEAD_PORT });
console.log(`  (unreachable backend = REAL RedisSessionHandler at 127.0.0.1:${DEAD_PORT}, nothing listening)\n`);

// Sanity: the driver really does fail. If this ever passes, every "unreachable"
// assertion below is vacuous, so it is checked rather than assumed.
{
  let threw = false;
  try { deadRedis().read("probe"); } catch { threw = true; }
  assert("driver sanity: a real handler at a closed port genuinely throws", threw,
    "if this passes, the port is not actually closed and the whole file is vacuous");
}

// ── default policy: log-loud + degrade ───────────────────────────────────────
console.log("\n-- Default policy: log-loud + degrade --");

// Invariant 1: unreachable backend on start() does NOT raise; returns an id,
// empty data, AND logs a real error line to the real log file.
{
  delete process.env.TINA4_SESSION_STRICT;
  const mark = logSize();
  const session = new Session();
  session.setHandler(deadRedis());
  let threw = false;
  let sid = "";
  try {
    sid = session.start("sess-1");
  } catch {
    threw = true;
  }
  const errs = errorLinesSince(mark);
  assert("start() on unreachable backend does NOT throw", !threw);
  assert("start() still issues a session id", typeof sid === "string" && sid.length > 0);
  assert("start() degrades to empty data (not crashed)", Object.keys(session.all()).length === 0);
  assert(
    "read failure reaches the REAL log file as a real ERROR line",
    errs.some((e) => e.message.includes("read") && e.message.includes("failed")),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );
  // The message must carry the real cause, not a generic placeholder -- this is
  // the assertion the fabricated `new Error("backend unreachable")` could never
  // make, because it never went near a socket.
  assert(
    "the logged cause is the REAL driver error (ECONNREFUSED), not a placeholder",
    errs.some((e) => /ECONNREFUSED|connect|refused/i.test(e.message)),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );
}

// Invariant 2: save() on an unreachable backend returns false, retains the
// dirty flag (so a later save retries), logs an error, does not crash.
{
  delete process.env.TINA4_SESSION_STRICT;
  const session = new Session();
  session.setHandler(deadRedis());
  session.start("sess-2");            // read failed + logged, degraded to empty
  const mark = logSize();
  session.set("user_id", 7);          // set() calls save() internally -> write fails
  const result = session.save();      // explicit re-save -> still false, retried
  const errs = errorLinesSince(mark);
  assert("save() on unreachable backend returns false", result === false);
  assert(
    "write failure reaches the REAL log file",
    errs.some((e) => e.message.includes("write") && e.message.includes("failed")),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );
  assert(
    "dirty flag retained for retry (save re-attempts the write)",
    errs.filter((e) => e.message.includes("write") && e.message.includes("failed")).length >= 2,
    `write-failure lines: ${errs.filter((e) => e.message.includes("write")).length}`,
  );
}

// Invariant 3a: destroy() on an unreachable backend logs but never raises.
{
  delete process.env.TINA4_SESSION_STRICT;
  const session = new Session();
  session.setHandler(deadRedis());
  session.start("sess-3");
  const mark = logSize();
  let threw = false;
  try {
    session.destroy();
  } catch {
    threw = true;
  }
  const errs = errorLinesSince(mark);
  assert("destroy() on unreachable backend does NOT throw", !threw);
  assert(
    "destroy failure reaches the REAL log file",
    errs.some((e) => e.message.includes("destroy") && e.message.includes("failed")),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );
}

// Invariant 3b: a gc() failure logs but never raises.
//
// This case had to change backend, and the reason is a FINDING, not a
// convenience. The old ExplodingHandler defined a gc() that threw, so the
// assertion passed. NO REAL NODE BACKEND CAN REACH IT:
//
//   * RedisSessionHandler / ValkeySessionHandler define no gc() at all (Redis
//     expires keys natively), and Session.gc() returns early when the handler
//     has none -- so nothing is attempted and nothing is logged.
//   * FileSessionHandler.gc() wraps its ENTIRE body in `try { ... } catch {}`
//     (session.ts:197), so a real failure is swallowed inside the handler and
//     never propagates to Session.gc()'s logBackendError.
//   * memcachedHandler.gc() is an empty no-op.
//
// So "a gc failure is logged, never silent" was true of the double and of
// nothing else. The DatabaseSessionHandler is the one real backend whose gc()
// lets an engine error out, so the invariant is pinned there -- driven by a
// SECOND, REAL sqlite connection holding a genuine EXCLUSIVE write lock, which
// is what a contended production database actually does. No doubles.
{
  delete process.env.TINA4_SESSION_STRICT;
  const dbDir = mkdtempSync(join(tmpdir(), "tina4-sessfail-db-"));
  const handler = new DatabaseSessionHandler({ dbPath: join(dbDir, "sess.db") });
  handler.write("gc-victim", { _created: 1, _accessed: 1 } as never, 1);

  const rival = new DatabaseSync(join(dbDir, "sess.db"));
  rival.exec("PRAGMA busy_timeout = 0");
  rival.exec("BEGIN EXCLUSIVE");
  rival.exec("INSERT INTO tina4_session (session_id, data, expires_at) VALUES ('rival','{}',1)");

  const session = new Session();
  session.setHandler(handler);
  const mark = logSize();
  let threw = false;
  try {
    session.gc();
  } catch {
    threw = true;
  }
  const errs = errorLinesSince(mark);
  assert("gc() on a genuinely locked backend does NOT throw", !threw);
  assert(
    "gc failure reaches the REAL log file",
    errs.some((e) => e.message.includes("gc") && e.message.includes("failed")),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );
  assert(
    "the logged gc cause is the REAL engine error (database is locked)",
    errs.some((e) => /locked|SQLITE/i.test(e.message)),
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );

  rival.exec("ROLLBACK");
  rival.close();

  // NEGATIVE CONTROL: with the lock released, the same real handler's gc()
  // succeeds and logs nothing. Without this, "gc logs an error" would pass for
  // an implementation that logs on every gc.
  const mark2 = logSize();
  session.gc();
  assert(
    "gc() on an UNCONTENDED real backend logs nothing",
    errorLinesSince(mark2).length === 0,
    `error lines: ${JSON.stringify(errorLinesSince(mark2).map((e) => e.message))}`,
  );
}

// ── Invariant 4: empty-but-healthy backend logs ZERO errors ──────────────────
//
// THE positive control, and the one the old EmptyHandler could not perform.
// A real Redis answering a missing key returns `$-1\r\n`; the regression this
// guards is the TRANSPORT misreading that null bulk reply as a connection
// failure. That decision lives in respCommandSync, which only runs against a
// real server.
console.log("\n-- Empty-but-healthy REAL backend is NOT a failure --");

if (await reachable(REDIS_HOST, REDIS_PORT)) {
  delete process.env.TINA4_SESSION_STRICT;
  const handler = new RedisSessionHandler({ redisHost: REDIS_HOST, redisPort: REDIS_PORT });
  const neverStored = `notasession-${randomUUID()}`;

  // Directly: a real read of a key the real server does not hold.
  const mark0 = logSize();
  let readThrew = false;
  let direct: unknown = "unset";
  try { direct = handler.read(neverStored); } catch { readThrew = true; }
  assert("a real missing key does not throw in the transport", !readThrew);
  assert("a real missing key reads as null (not an error)", direct === null,
    `got ${JSON.stringify(direct)}`);
  assert(
    "a real missing-key read logs ZERO errors",
    errorLinesSince(mark0).length === 0,
    `error lines: ${JSON.stringify(errorLinesSince(mark0).map((e) => e.message))}`,
  );

  // Through Session.start(), which is how the framework reaches it.
  const mark1 = logSize();
  const session = new Session();
  session.setHandler(handler);
  const sid = session.start(`notasession-${randomUUID()}`);
  const errs = errorLinesSince(mark1);
  assert("empty healthy backend yields empty session", Object.keys(session.all()).length === 0);
  assert("empty healthy backend still issues an id", typeof sid === "string" && sid.length > 0);
  assert(
    "empty (but successful) read logs ZERO errors against a LIVE server",
    errs.length === 0,
    `error lines: ${JSON.stringify(errs.map((e) => e.message))}`,
  );

  // NEGATIVE CONTROL for the whole live-Redis block: the same real handler must
  // still round-trip real data. Without this, a broken handler that returns null
  // for everything passes every assertion above.
  const roundTrip = new Session();
  roundTrip.setHandler(handler);
  const liveId = roundTrip.start();
  roundTrip.set("marker", "alive");
  const saved = roundTrip.save();
  const reader = new Session();
  reader.setHandler(handler);
  reader.start(liveId);
  assert("live Redis save() succeeds", saved === true);
  assert("live Redis round-trips real data across two Session instances",
    reader.get("marker") === "alive", `got ${JSON.stringify(reader.get("marker"))}`);
  roundTrip.destroy();
} else {
  skip("empty-but-healthy REAL backend", `redis not reachable at ${REDIS_HOST}:${REDIS_PORT}`);
}

// ── Invariant 5: strict mode re-raises ───────────────────────────────────────
console.log("\n-- Strict mode (TINA4_SESSION_STRICT=true) re-raises --");

// 5a: read failure re-raises under strict -- driven by the real dead port.
{
  process.env.TINA4_SESSION_STRICT = "true";
  const session = new Session();          // reads strict flag in ctor
  session.setHandler(deadRedis());
  let threw = false;
  try {
    session.start("sess-strict");
  } catch {
    threw = true;
  }
  assert("strict mode re-raises a REAL read failure", threw);
}

// 5b: write failure re-raises under strict.
//
// The old file used a counting `WriteFailsAfterStartHandler` engineered to
// throw on write #2 -- it asserted the branch was reachable BY CONSTRUCTION.
// Here the real FileSessionHandler's first write genuinely succeeds, then the
// directory is made read-only and the second write takes a real EACCES from the
// kernel. Same branch, reached by a real outage.
{
  process.env.TINA4_SESSION_STRICT = "true";
  const sessDir = mkdtempSync(join(tmpdir(), "tina4-sessfail-store-"));
  const handler = new FileSessionHandler(sessDir);
  const session = new Session();
  session.setHandler(handler);
  const sid = session.start();            // real bootstrap write succeeds
  assert("real file backend accepted the bootstrap write", typeof sid === "string" && sid.length > 0);

  // Make the session's OWN FILE read-only. chmod'ing the directory is not
  // enough and that is a real POSIX detail, not a nicety: writeFileSync to an
  // EXISTING path needs write permission on the FILE; directory permission
  // governs create/unlink/rename. Measured on this host -- dir 0500 alone let
  // the write through, file 0400 produced a real EACCES.
  const sessFile = sessionFile(sessDir, sid);
  const fileFound = existsSync(sessFile);
  // Assert the path BEFORE chmod'ing it. A wrong path used to blow up as an
  // ENOENT that took the process down mid-file; as an assertion it is a reported
  // failure, and it doubles as the gate that the record really is stored under
  // the id's SHA-256 (ADR-0021) rather than the raw id.
  assert("the bootstrap write landed at the id's SHA-256 path (ADR-0021)", fileFound,
    `expected ${sessFile}; dir contains ${readdirSync(sessDir).join(",")}`);
  if (fileFound) chmodSync(sessFile, 0o400);
  let threw = false;
  let cause = "";
  try {
    session.set("k", "v");                // set() -> save() -> real EACCES
  } catch (err) {
    threw = true;
    cause = String((err as Error)?.message ?? err);
  } finally {
    if (fileFound) chmodSync(sessFile, 0o600);  // restore so the temp dir can be cleaned
  }

  if (!threw && process.getuid?.() === 0) {
    // Running as root defeats the permission bit, so the outage never happened.
    // Say so rather than reporting a pass we did not earn.
    skip("strict mode re-raises a REAL write failure",
      "running as uid 0, so chmod 0500 does not block the write; cannot drive a real EACCES here");
  } else {
    assert("strict mode re-raises a REAL write failure (EACCES on a read-only dir)", threw,
      "the chmod 0500 directory did not produce a real write error");
    assert("the re-raised cause is the REAL errno, not a fabricated message",
      /EACCES|permission denied/i.test(cause), `cause: ${cause}`);
  }
}

// 5c: NEGATIVE CONTROL for strict mode -- a healthy real backend under strict
// must still work. Without this, "strict re-raises" passes for an
// implementation that throws unconditionally.
{
  process.env.TINA4_SESSION_STRICT = "true";
  const sessDir = mkdtempSync(join(tmpdir(), "tina4-sessfail-ok-"));
  const session = new Session();
  session.setHandler(new FileSessionHandler(sessDir));
  let threw = false;
  try {
    const sid = session.start();
    session.set("k", "v");
    session.save();
    const reader = new Session();
    reader.setHandler(new FileSessionHandler(sessDir));
    reader.start(sid);
    assert("strict mode: a HEALTHY real backend still round-trips", reader.get("k") === "v",
      `got ${JSON.stringify(reader.get("k"))}`);
  } catch (err) {
    threw = true;
    console.log(`    (unexpected throw: ${String(err)})`);
  }
  assert("strict mode does not throw on a healthy real backend", !threw);
}

delete process.env.TINA4_SESSION_STRICT;

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`
  + (skipped ? `, \x1b[33m${skipped} skipped\x1b[0m` : "")
);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
