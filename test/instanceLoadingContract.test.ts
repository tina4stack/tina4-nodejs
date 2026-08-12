/**
 * Feature 26 - ORM instance loading / hydration: the shared conformance
 * contract, parity with tina4-python/tests/test_instance_loading_contract.py.
 *
 * LOAD-DEC-01: Node's constructor already coerces JSON on every read path
 * (find/all/where/select/load all route through `new this(row)` ->
 * fromDbFieldValue) -- Node never had Python's LOAD-PY-REVALIDATE footgun
 * (validateFields() is called ONLY by the explicit validate()/save(), never by
 * the constructor) nor Ruby's LOAD-RUBY-ASYMMETRY (load() already delegated to
 * selectOne(), one hydration path). Those two cases below are expected to be
 * no-op / already-correct proofs for Node -- a regression lock, not a fix.
 *
 * LOAD-NODE-SERIALIZE-OMIT (LOAD-DEC-02, the real Node defect): toDict()/
 * toJson() SILENTLY omitted a declared relation that was requested via
 * `include` but never eager-loaded (a synchronous serializer cannot
 * lazy-load it) -- no signal at all. Fixed: the omission now logs
 * Log.warning() naming the model, the relation, and that `include` on the
 * finder is needed -- it still does NOT throw (serialization keeps working)
 * and the returned shape is UNCHANGED (the relation is still absent).
 *
 * LOAD-JSON-ONLY (LOAD-DEC-02): the scalar read-coercion contract is PINNED as
 * JSON-only (OWNER-DECISIONS.md Batch 5) -- Node already coerces ONLY JSON
 * columns on read (fromDbFieldValue, unchanged); non-JSON scalars stay
 * driver-typed.
 *
 * Case names are shared verbatim across all four frameworks and gated by
 * scripts/audit-contract-fixtures.py.
 *
 * NO MOCKS: real SQLite (always) + real PostgreSQL :55432 tina4/tina4 (gated --
 * skips cleanly when unreachable locally, a hard failure under
 * TINA4_REQUIRE_SERVICES, e.g. on the lab).
 *
 * Run with: npx tsx test/instanceLoadingContract.test.ts
 */
import process from "node:process";
import net from "node:net";
import { rmSync, mkdirSync } from "node:fs";
import {
  BaseModel,
  Database,
  bindDatabase,
  createAdapterFromUrl,
  initDatabase,
  closeDatabase,
} from "../packages/orm/src/index.js";
import { Log } from "../packages/core/src/index.js";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const requireServices = /^(1|true|yes|on)$/i.test(process.env.TINA4_REQUIRE_SERVICES ?? "");

/** A provisioned service (PG) that is missing is a hard FAILURE under the gate. */
function skip(msg: string): void {
  if (requireServices) {
    console.error(`  \x1b[31mSKIP-AS-FAIL\x1b[0m ${msg}`);
    process.exit(1);
  }
  console.log(`  \x1b[33mSKIP\x1b[0m ${msg}`);
}

function tcpReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * Deterministic JSON.stringify with OBJECT keys sorted recursively (array
 * ELEMENT order is left significant). Used to compare a hydrated JSON column
 * for equal content regardless of key order: PostgreSQL's JSONB storage does
 * not preserve object key insertion order (SQLite's TEXT column does), so the
 * SAME data can legitimately come back "{"n":1,"tags":[...]}" on one engine
 * and "{"tags":[...],"n":1}" on the other -- a real, engine-level JSONB
 * property, not a hydration bug. A plain JSON.stringify() comparison is
 * order-sensitive and would fail on that engine difference alone.
 */
function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sortKeys((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

// ── models ────────────────────────────────────────────────────────────────
//
// V1 ("loose"): defines the table's DDL. `name` carries no `required` -- the
// column stays nullable, so a legitimate pre-existing row CAN hold NULL.
class LoadContractItemV1 extends BaseModel {
  static tableName = "load_contract_item";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
    payload: { type: "json" },
    active: { type: "boolean", default: true },
  } as const;
}
// V2 ("tight"): the SAME table, but `name` is `required: true` -- simulating a
// constraint TIGHTENED after the row already existed (LOAD-PY-REVALIDATE).
// TypeScript's erased types mean this was NEVER at risk of a runtime type
// crash -- this proves it stays that way (a regression lock, not a fix).
class LoadContractItemV2 extends BaseModel {
  static tableName = "load_contract_item";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string", required: true },
    payload: { type: "json" },
    active: { type: "boolean", default: true },
  } as const;
}

// ── LOAD-NODE-SERIALIZE-OMIT models (Node-scoped) ───────────────────────────
class LoadContractParent extends BaseModel {
  static tableName = "load_contract_parent";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string" },
  } as const;
}
class LoadContractChild extends BaseModel {
  static tableName = "load_contract_child";
  static fields = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    parent_id: { type: "foreignKey", references: "LoadContractParent", relatedName: "children" },
    label: { type: "string" },
  } as const;
}

async function runCases(): Promise<void> {
  await LoadContractItemV1.createTable();

  // ── json_column_round_trips_via_finder ────────────────────────────────
  const saved = new LoadContractItemV1({ name: "alice", payload: { tags: ["a", "b"], n: 1 } });
  const savedResult = await saved.save();
  check("finder: save() succeeds", savedResult !== false);

  const got = await LoadContractItemV1.findById(saved.id as number);
  check(
    "json_column_round_trips_via_finder: payload is a native object, not a string",
    typeof got?.payload === "object" && got?.payload !== null,
    `typeof payload = ${typeof got?.payload}`,
  );
  check(
    "json_column_round_trips_via_finder",
    canonicalJson(got?.payload) === canonicalJson({ tags: ["a", "b"], n: 1 }),
    `expected {tags:[a,b],n:1}, got ${JSON.stringify(got?.payload)}`,
  );

  // ── json_column_round_trips_via_load ──────────────────────────────────
  const reloaded = new LoadContractItemV1();
  (reloaded as any).id = saved.id;
  const loadedOk = await reloaded.load();
  check("load() finds the row", loadedOk === true);
  check(
    "json_column_round_trips_via_load: payload is a native object, not a string",
    typeof reloaded.payload === "object" && reloaded.payload !== null,
    `typeof payload = ${typeof reloaded.payload}`,
  );
  check(
    "json_column_round_trips_via_load",
    canonicalJson(reloaded.payload) === canonicalJson({ tags: ["a", "b"], n: 1 }),
    `expected {tags:[a,b],n:1}, got ${JSON.stringify(reloaded.payload)}`,
  );

  // ── constraint_violating_stored_row_still_hydrates ─────────────────────
  // V1 (no `required` on `name`) legitimately stores a null name -- an
  // ordinary nullable-column row, saved through the NORMAL write path.
  const stored = new LoadContractItemV1({ name: null, payload: { k: "v" } });
  const storedResult = await stored.save();
  check("constraint case: seed row saves", storedResult !== false);

  // V2 (SAME table, `name` now required: true) reads it back.
  const stillReadable = await LoadContractItemV2.findById(stored.id as number);
  check(
    "constraint_violating_stored_row_still_hydrates",
    stillReadable !== null,
    "a required-but-null stored row must still hydrate via findById()",
  );
  check("hydrated name stays null", (stillReadable as any)?.name === null || (stillReadable as any)?.name === undefined);

  // The SAME row must also survive a full all() (not just a single find),
  // proving one non-conforming row does not abort a page of results.
  const allRows = await LoadContractItemV2.all();
  check(
    "all() is not aborted by the non-conforming row",
    allRows.some((r: any) => r.id === stored.id),
  );

  // Prove the write path is UNCHANGED: V2's OWN save() still rejects a NEW
  // row missing the now-required `name` -- this is a read-only fix, not a
  // deleted constraint.
  const rejected = new LoadContractItemV2({ payload: {} });
  const rejectResult = await rejected.save();
  check("save() still rejects a missing required field", rejectResult === false);
  const err = rejected.getError();
  check("the rejection cause names 'required'", !!err && err.toLowerCase().includes("required"), String(err));

  // ── partial_select_yields_partial_instance ─────────────────────────────
  const full = new LoadContractItemV1({ name: "partial-target", payload: { z: 9 } });
  await full.save();
  const partial = await LoadContractItemV1.select(
    "SELECT id, name FROM load_contract_item WHERE id = ?", [full.id],
  );
  check("partial select returns exactly one row", partial.length === 1, String(partial.length));
  const inst: any = partial[0];
  check("partial_select_yields_partial_instance: selected column present", inst.name === "partial-target");
  check("unselected field (active) sits at its declared default", inst.active === true, String(inst.active));
  check("unselected field (payload) is not a stale/wrong value", inst.payload === undefined || inst.payload === null);
}

// ── LOAD-NODE-SERIALIZE-OMIT (Node-scoped) ──────────────────────────────────
async function runSerializeOmitCase(): Promise<void> {
  await LoadContractParent.createTable();
  await LoadContractChild.createTable();

  const parent = new LoadContractParent({ name: "p1" });
  await parent.save();
  const child = new LoadContractChild({ parent_id: parent.id, label: "c1" });
  await child.save();

  // Fetch the parent WITHOUT include -- children never eager-loaded.
  const fetchedParent: any = await LoadContractParent.findById(parent.id as number);

  const originalLog = console.log;
  let captured = "";
  console.log = (...args: unknown[]) => { captured += args.join(" ") + "\n"; };
  const dict = fetchedParent.toDict(["children"]);
  console.log = originalLog;

  check(
    "unloaded_relation_serialization_warns_not_silent: relation still omitted (shape unchanged)",
    !("children" in dict),
    JSON.stringify(dict),
  );
  check(
    "unloaded_relation_serialization_warns_not_silent: a warning names the relation",
    captured.toLowerCase().includes("children"),
    captured,
  );
  check(
    "unloaded_relation_serialization_warns_not_silent: the warning names the fix (include)",
    captured.toLowerCase().includes("include"),
    captured,
  );
  check(
    "toDict() never throws for the omitted relation",
    typeof dict === "object" && dict !== null,
  );
}

// ── sqlite ───────────────────────────────────────────────────────────────
console.log("=== ORM instance loading contract (feature 26) — sqlite ===\n");
const SQLITE_DIR = "/tmp/tina4-instance-loading-test";
try { rmSync(SQLITE_DIR, { recursive: true }); } catch { /* ignore */ }
mkdirSync(SQLITE_DIR, { recursive: true });
await initDatabase({ type: "sqlite", path: `${SQLITE_DIR}/test.db` });
await runCases();
await runSerializeOmitCase();
closeDatabase();
try { rmSync(SQLITE_DIR, { recursive: true }); } catch { /* ignore */ }

// ── postgres (gated) ────────────────────────────────────────────────────
console.log("\n=== ORM instance loading contract (feature 26) — postgres ===\n");
const PG = {
  host: process.env.TINA4_TEST_PG_HOST ?? "127.0.0.1",
  port: parseInt(process.env.TINA4_TEST_PG_PORT ?? "55432", 10),
  user: process.env.TINA4_TEST_PG_USERNAME ?? "tina4",
  pass: process.env.TINA4_TEST_PG_PASSWORD ?? "tina4",
  db: process.env.TINA4_TEST_PG_DB ?? "tina4_node",
};
if (!(await tcpReachable(PG.host, PG.port))) {
  skip(`postgres unreachable at ${PG.host}:${PG.port} (set TINA4_TEST_PG_*)`);
} else {
  const adapter: any = await createAdapterFromUrl(`postgres://${PG.user}:${PG.pass}@${PG.host}:${PG.port}/${PG.db}`);
  const db = new Database(adapter);
  bindDatabase(adapter);
  try { await db.execute("DROP TABLE IF EXISTS load_contract_item"); } catch { /* ignore */ }
  try { await db.execute("DROP TABLE IF EXISTS load_contract_child"); } catch { /* ignore */ }
  try { await db.execute("DROP TABLE IF EXISTS load_contract_parent"); } catch { /* ignore */ }
  try {
    await runCases();
    await runSerializeOmitCase();
  } finally {
    try { await db.execute("DROP TABLE IF EXISTS load_contract_item"); } catch { /* ignore */ }
    try { await db.execute("DROP TABLE IF EXISTS load_contract_child"); } catch { /* ignore */ }
    try { await db.execute("DROP TABLE IF EXISTS load_contract_parent"); } catch { /* ignore */ }
    closeDatabase();
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
