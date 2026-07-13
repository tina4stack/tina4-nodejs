/**
 * Real, NO-MOCK regression test for the dev-admin connection-tester endpoint
 * (POST /__dev/api/connections/test -> handleConnectionsTest in
 * packages/core/src/devAdmin.ts).
 *
 * Run with: npx tsx test/connectionsTest.test.ts
 *
 * Regression target: handleConnectionsTest called db.getTables() and the
 * version query WITHOUT `await` (both return a Promise). Array.isArray(<Promise>)
 * is false, so the endpoint ALWAYS reported "0 tables" and fell back to the
 * generic "Connected" version string — no matter what was really in the
 * database. The fix awaits db.getTables() and db.fetchOne(...). This test would
 * FAIL against the old un-awaited code (tables === 0, version === "Connected")
 * and PASSES now.
 *
 * NO MOCKS: a real temp SQLite database is created through the REAL ORM
 * (node:sqlite), real tables (`alpha`, `beta`) are added, and the REAL handler
 * is driven end to end against that real database. The req/res are plain
 * transport shells — the same harness test/devAdmin.test.ts uses to exercise
 * dev-admin handlers — while the DB dependency is 100% real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DevAdmin, Router } from "../packages/core/src/index.ts";
import { initDatabase } from "../packages/orm/src/index.ts";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    failed++;
  }
}

// Plain transport shells (NOT mocks of any dependency) — the handler reads
// req.body and writes via res.json(); the real database work underneath is 100%
// real node:sqlite through the real ORM.
function mockReq(body: Record<string, string>): any {
  return { url: "/__dev/api/connections/test", headers: {}, method: "POST", body };
}
function mockRes(): any {
  let captured: any = undefined;
  return {
    json(data: any, _status?: number) { captured = data; },
    html(_data: any, _status?: number) {},
    get result() { return captured; },
  };
}

async function main(): Promise<void> {
  // DevAdmin.isEnabled() / register-time gating reads TINA4_DEBUG.
  process.env.TINA4_DEBUG = "true";

  const dir = mkdtempSync(join(tmpdir(), "tina4-conn-test-"));
  const dbFile = join(dir, "conn.db");
  const url = `sqlite:///${dbFile}`;

  try {
    // ── Real database via the real ORM: two real tables + a row ──
    const db = await initDatabase({ url });
    await db.execute("CREATE TABLE alpha (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await db.execute("CREATE TABLE beta (id INTEGER PRIMARY KEY, label TEXT)");
    await db.execute("INSERT INTO alpha (name) VALUES ('one')");

    // Core regression — getTables() is async (Promise<string[]>). The old
    // un-awaited call yielded a Promise, Array.isArray(<Promise>) === false, so
    // the reported count was always 0. Awaited, it must see both real tables.
    const tables = await db.getTables();
    assert("await db.getTables() returns an array", Array.isArray(tables), `typeof=${typeof tables}`);
    assert(
      "await db.getTables() includes the 2 real tables (>= 2)",
      Array.isArray(tables) && tables.length >= 2 && tables.includes("alpha") && tables.includes("beta"),
      JSON.stringify(tables),
    );

    // The version query is async too — un-awaited it returned a Promise and the
    // endpoint fell back to the "Connected" default instead of a real version.
    const row = await db.fetchOne<{ v?: string }>("SELECT sqlite_version() as v");
    assert("await db.fetchOne(sqlite_version()) yields a real version", !!row?.v, JSON.stringify(row));
    db.close();

    // ── Drive the REAL route handler end to end against the real file DB ──
    const router = new Router();
    DevAdmin.register(router);
    const route = router.getRoutes().find(
      (r) => r.method === "POST" && r.pattern === "/__dev/api/connections/test",
    );
    assert("connections/test handler is registered", route?.handler !== undefined);

    if (route?.handler) {
      const res = mockRes();
      await route.handler(mockReq({ url }), res);
      const data = res.result;

      assert("handler responds success === true", data?.success === true, JSON.stringify(data));
      // 0 under the old un-awaited bug; must be the 2 real tables now.
      assert(
        "handler reports tables >= 2 (was always 0 under the un-awaited bug)",
        Number(data?.tables) >= 2,
        `tables=${data?.tables}`,
      );
      // A REAL version string "SQLite <n>.<n>.<n>" now. The un-awaited bug left
      // the version query a floating Promise, so the branch produced only the
      // bare label "SQLite " (empty version) — hence the `\d` requirement, which
      // fails on the bug's empty version but passes on the real one.
      assert(
        'handler version is a real "SQLite <version>" (empty under the un-awaited bug)',
        typeof data?.version === "string" && /SQLite \d/.test(data.version),
        `version=${data?.version}`,
      );
    }

    // Negative path — no URL is a clean failure, not a throw.
    if (route?.handler) {
      const res = mockRes();
      await route.handler(mockReq({} as Record<string, string>), res);
      assert(
        "handler with no url → success:false + error",
        res.result?.success === false && typeof res.result?.error === "string" && res.result.error.length > 0,
        JSON.stringify(res.result),
      );
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  console.log(`\nResults: ${passed} passed, ${failed + 1} failed`);
  process.exit(1);
});
