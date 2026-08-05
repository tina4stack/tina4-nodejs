/**
 * Firebird URL parsing + TINA4_DATABASE_FIREBIRD_PATH override tests.
 *
 * The Firebird URL is the awkward one in the stack — every other engine
 * (PostgreSQL, MySQL, MSSQL) has a server-side database name where you can
 * write `pg://host:port/dbname` and the path component is just a name.
 * Firebird wants either an absolute file path on the server, a Windows
 * drive-letter path, or an alias. The classic URI form needs a double
 * slash to keep the absolute path through URL parsing, which is unintuitive.
 *
 * This suite verifies the framework accepts five equivalent forms and also
 * honours TINA4_DATABASE_FIREBIRD_PATH as an explicit override (useful for
 * Windows backslash paths and ops setups that keep config split across layers).
 *
 * Run with: npx tsx test/firebirdUrl.test.ts
 */
import { normalizeFirebirdDbIdentifier, FirebirdAdapter } from "../packages/orm/src/index.ts";
import { createConnection } from "node:net";
import { createRequire } from "node:module";

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

console.log("=== Firebird URL Tests ===\n");

// ── normalizeFirebirdDbIdentifier ────────────────────────────────────────

console.log("--- normalizeFirebirdDbIdentifier ---");

assert(
  "classic double-slash absolute path",
  // firebird://host:port//abs/path/db.fdb -> URL pathname = //abs/path/db.fdb
  normalizeFirebirdDbIdentifier("//firebird/data/app.fdb") === "/firebird/data/app.fdb",
);

assert(
  "single-slash absolute path",
  // firebird://host:port/abs/path/db.fdb -> URL pathname = /abs/path/db.fdb
  normalizeFirebirdDbIdentifier("/firebird/data/app.fdb") === "/firebird/data/app.fdb",
);

assert(
  "windows drive letter with leading slash",
  // firebird://host:port/C:/Data/db.fdb -> URL pathname = /C:/Data/db.fdb
  normalizeFirebirdDbIdentifier("/C:/Data/app.fdb") === "C:/Data/app.fdb",
);

assert(
  "windows drive letter url-encoded",
  // firebird://host:port/C%3A/Data/db.fdb -> URL pathname = /C%3A/Data/db.fdb
  normalizeFirebirdDbIdentifier("/C%3A/Data/app.fdb") === "C:/Data/app.fdb",
);

assert(
  "alias single token",
  // firebird://host:port/employee -> URL pathname = /employee
  normalizeFirebirdDbIdentifier("/employee") === "employee",
);

assert(
  "relative path with slash promoted to absolute",
  // If a user writes a path-like value without a leading slash, treat it as
  // an absolute path (Firebird has no notion of relative paths anyway).
  // Prepend a slash so the driver sees an absolute path and errors clearly
  // if it doesn't exist.
  normalizeFirebirdDbIdentifier("data/app.fdb") === "/data/app.fdb",
);

assert(
  "url-encoded unicode in path",
  // Path with URL-encoded non-ASCII char — decoded correctly.
  normalizeFirebirdDbIdentifier("/data/d%C3%A9j%C3%A0.fdb") === "/data/déjà.fdb",
);

assert(
  "lowercase drive letter",
  // Lowercase drive letters must work the same as uppercase.
  normalizeFirebirdDbIdentifier("/c:/data/app.fdb") === "c:/data/app.fdb",
);

// ── End-to-end against a live Firebird container ──────────────────────────

console.log("\n--- Live Firebird connectivity ---");

// Where the live Firebird actually is: TINA4_TEST_FIREBIRD_URL when set -- the
// SAME variable the Python and PHP suites already read, so one export points
// every framework at the same container.
//
// These three were hard-coded to localhost:53050 and /firebird/data/tina4.fdb,
// one particular container layout. Nothing publishes 53050 on the lab (Firebird
// is on 3050), so the reachability gate below could NEVER open: the live tests
// skipped on every machine, which looks exactly like "the environment is not set
// up" and is how a permanently dead test stays invisible. The literals remain
// the fallback, so a host that really does publish 53050 with that database path
// behaves precisely as before.
function liveFirebirdTarget(): [string, number, string] {
  const raw = (process.env.TINA4_TEST_FIREBIRD_URL ?? "").trim();
  if (!raw) return ["localhost", 53050, "/firebird/data/tina4.fdb"];

  const parsed = new URL(raw);
  let path = parsed.pathname ?? "";
  // `@host:port//abs/path` is the absolute-path spelling; collapse the doubled
  // leading slash so this is a plain absolute path again. The tests below re-add
  // it for the double-slash form and strip it for the single-slash one.
  if (path.startsWith("//")) path = path.slice(1);
  return [
    parsed.hostname || "localhost",
    parsed.port ? Number(parsed.port) : 3050,
    path || "/firebird/data/tina4.fdb",
  ];
}

const [FIREBIRD_HOST, FIREBIRD_PORT, LIVE_DB_PATH] = liveFirebirdTarget();

async function firebirdReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: FIREBIRD_HOST, port: FIREBIRD_PORT, timeout: 1000 });
    const cleanup = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => cleanup(true));
    socket.once("timeout", () => cleanup(false));
    socket.once("error", () => cleanup(false));
  });
}

function nodeFirebirdInstalled(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve("node-firebird");
    return true;
  } catch {
    return false;
  }
}

/** Probe node-firebird against the live container with the known-good path.
 *  Some node-firebird/server combos throw uncaught wire errors that escape
 *  promise wrappers; if that's the case here, we skip the live tests rather
 *  than tearing down the whole process. */
async function probeNodeFirebirdWorks(): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: { ok: boolean; reason?: string }) => {
      if (settled) return;
      settled = true;
      process.removeListener("uncaughtException", onUncaught);
      resolve(result);
    };
    const onUncaught = (err: Error) => {
      settle({ ok: false, reason: `node-firebird wire error: ${err.message}` });
    };
    process.on("uncaughtException", onUncaught);
    try {
      const req = createRequire(import.meta.url);
      const fb = req("node-firebird");
      fb.attach(
        {
          host: FIREBIRD_HOST,
          port: FIREBIRD_PORT,
          database: LIVE_DB_PATH,
          user: "SYSDBA",
          password: "masterkey",
          pageSize: 4096,
        },
        (err: Error | null, db: any) => {
          if (err) return settle({ ok: false, reason: err.message });
          try { db.detach(); } catch { /* ignore */ }
          settle({ ok: true });
        },
      );
      // Hard timeout — if the wire never finishes, treat as broken.
      setTimeout(() => settle({ ok: false, reason: "node-firebird probe timeout" }), 3000);
    } catch (e) {
      settle({ ok: false, reason: (e as Error).message });
    }
  });
}

const reachable = await firebirdReachable();
const driverInstalled = nodeFirebirdInstalled();
const probe = reachable && driverInstalled
  ? await probeNodeFirebirdWorks()
  : { ok: false, reason: "skipped probe" };

async function runQueryOne<T = unknown>(adapter: FirebirdAdapter, sql: string): Promise<T | null> {
  const rows = await adapter.fetchOneAsync<T>(sql);
  return rows;
}

async function attemptConnect(
  url: string,
  envOverride: string | undefined,
): Promise<{ ok: boolean; err?: string; value?: unknown }> {
  const previous = process.env.TINA4_DATABASE_FIREBIRD_PATH;
  if (envOverride === undefined) {
    delete process.env.TINA4_DATABASE_FIREBIRD_PATH;
  } else {
    process.env.TINA4_DATABASE_FIREBIRD_PATH = envOverride;
  }
  const adapter = new FirebirdAdapter(url);
  try {
    await adapter.connect();
    const row = await runQueryOne<Record<string, unknown>>(
      adapter,
      "SELECT 1 AS X FROM rdb$database",
    );
    const value = row ? row["X"] ?? row["x"] : undefined;
    adapter.close();
    return { ok: true, value };
  } catch (e) {
    try { adapter.close(); } catch { /* ignore */ }
    return { ok: false, err: (e as Error).message };
  } finally {
    if (previous === undefined) {
      delete process.env.TINA4_DATABASE_FIREBIRD_PATH;
    } else {
      process.env.TINA4_DATABASE_FIREBIRD_PATH = previous;
    }
  }
}

if (!reachable) {
  skip("connect via single-slash URL form", `Firebird not reachable at ${FIREBIRD_HOST}:${FIREBIRD_PORT}`);
  skip("connect via double-slash URL form", `Firebird not reachable at ${FIREBIRD_HOST}:${FIREBIRD_PORT}`);
  skip("env override wins over wrong URL path", `Firebird not reachable at ${FIREBIRD_HOST}:${FIREBIRD_PORT}`);
} else if (!driverInstalled) {
  skip("connect via single-slash URL form", "node-firebird package not installed");
  skip("connect via double-slash URL form", "node-firebird package not installed");
  skip("env override wins over wrong URL path", "node-firebird package not installed");
} else if (!probe.ok) {
  skip("connect via single-slash URL form", probe.reason ?? "node-firebird probe failed");
  skip("connect via double-slash URL form", probe.reason ?? "node-firebird probe failed");
  skip("env override wins over wrong URL path", probe.reason ?? "node-firebird probe failed");
} else {
  // Single-slash form: written as "firebird://host:port/firebird/data/tina4.fdb"
  // The normalizer promotes the relative-looking path to absolute.
  const singleSlashUrl =
    `firebird://SYSDBA:masterkey@${FIREBIRD_HOST}:${FIREBIRD_PORT}${LIVE_DB_PATH}`;
  const single = await attemptConnect(singleSlashUrl, undefined);
  assert(
    "connect via single-slash URL form",
    single.ok && Number(single.value) === 1,
    single.err ?? `value=${String(single.value)}`,
  );

  // Double-slash form: written as "firebird://host:port//firebird/data/tina4.fdb".
  // After parseDatabaseUrl-style splitting the database path is "//firebird/data/tina4.fdb",
  // and the normalizer collapses it back to "/firebird/data/tina4.fdb".
  const doubleSlashUrl =
    `firebird://SYSDBA:masterkey@${FIREBIRD_HOST}:${FIREBIRD_PORT}/${LIVE_DB_PATH}`;
  const dbl = await attemptConnect(doubleSlashUrl, undefined);
  assert(
    "connect via double-slash URL form",
    dbl.ok && Number(dbl.value) === 1,
    dbl.err ?? `value=${String(dbl.value)}`,
  );

  // env override: provide a deliberately wrong URL path; the env override
  // points at the real DB. The framework should connect to the real one.
  const wrongUrl =
    `firebird://SYSDBA:masterkey@${FIREBIRD_HOST}:${FIREBIRD_PORT}/this/path/does/not/exist.fdb`;
  const overridden = await attemptConnect(wrongUrl, LIVE_DB_PATH);
  assert(
    "env override wins over wrong URL path",
    overridden.ok && Number(overridden.value) === 1,
    overridden.err ?? `value=${String(overridden.value)}`,
  );
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(
  `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`,
);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
