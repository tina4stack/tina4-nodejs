/**
 * Feature 19 - Input and request validation: the shared conformance contract.
 * Parity with tina4-python/tests/test_validation_contract.py,
 * tina4-php/tests/ValidationContractTest.php,
 * tina4-ruby/spec/validation_contract_spec.rb.
 *
 * Two validators, both REAL-tested (no mocks, no doubles):
 *   1. the chainable request-body Validator (advisory) - every rule pos + neg;
 *   2. ORM field validation, ENFORCED on save() - a constraint-violating model
 *      returns false AND writes NOTHING (verified by a real COUNT(*) after);
 *   3. both validators speak ONE canonical message vocabulary per rule
 *      (VALID-TWO-MESSAGES - Node's request Validator is the reference);
 *   4. Node-only: AutoCrud PUT validates the body (VALID-NODE-PUT-NOVALIDATE)
 *      and wires the partial-update mode, proven over a REAL socket + SQLite.
 *
 * Case names are shared verbatim across the four frameworks and gated by
 * scripts/audit-contract-fixtures.py. Imports the source directly so tsx runs
 * the checked-out tree.
 */
import process from "node:process";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Validator, createResponse } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";
import {
  BaseModel, initDatabase, getAdapter, adapterExecute, adapterQuery, closeDatabase,
  generateCrudRoutes,
} from "../packages/orm/src/index.ts";
import type { DiscoveredModel } from "../packages/orm/src/index.ts";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail = ""): void {
  if (condition) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); }
}

const ROLES = ["admin", "user", "guest"];

// ── 1. request-body Validator: every rule, positive AND negative ─────────────
console.log("--- request Validator rules (pos + neg) ---");

check("required rule passes a present value and reports a missing one",
  new Validator({ name: "Alice" }).required("name").isValid() &&
  !new Validator({ name: "" }).required("name").isValid() &&
  new Validator({ name: "" }).required("name").errors()[0].message === "name is required");

check("email rule passes a valid address and reports an invalid one",
  new Validator({ email: "a@b.co" }).email("email").isValid() &&
  new Validator({ email: "nope" }).email("email").errors()[0].message === "email must be a valid email address");

check("min length rule passes a long value and reports a short one",
  new Validator({ name: "Alice" }).minLength("name", 2).isValid() &&
  new Validator({ name: "A" }).minLength("name", 2).errors()[0].message === "name must be at least 2 characters");

check("max length rule passes a short value and reports a long one",
  new Validator({ name: "Al" }).maxLength("name", 5).isValid() &&
  new Validator({ name: "Alexander" }).maxLength("name", 5).errors()[0].message === "name must be at most 5 characters");

check("integer rule passes an integer and reports a non integer",
  new Validator({ age: 30 }).integer("age").isValid() &&
  new Validator({ age: "abc" }).integer("age").errors()[0].message === "age must be an integer");

check("min rule passes a value above the minimum and reports one below",
  new Validator({ age: 5 }).min("age", 0).isValid() &&
  new Validator({ age: -5 }).min("age", 0).errors()[0].message === "age must be at least 0");

check("max rule passes a value below the maximum and reports one above",
  new Validator({ age: 40 }).max("age", 65).isValid() &&
  new Validator({ age: 999 }).max("age", 65).errors()[0].message === "age must be at most 65");

check("in list rule passes an allowed value and reports a disallowed one",
  new Validator({ role: "admin" }).inList("role", ROLES).isValid() &&
  new Validator({ role: "root" }).inList("role", ROLES).errors()[0].message ===
    'role must be one of ["admin","user","guest"]');

check("regex rule passes a matching value and reports a non matching one",
  new Validator({ code: "123" }).regex("code", "^[0-9]+$").isValid() &&
  new Validator({ code: "abc" }).regex("code", "^[0-9]+$").errors()[0].message ===
    "code does not match the required format");

check("is valid reflects whether any rule failed",
  new Validator({ name: "Al", age: 30 }).required("name").integer("age").isValid() === true &&
  new Validator({ name: "", age: "x" }).required("name").integer("age").isValid() === false &&
  new Validator({ name: "", age: "x" }).required("name").integer("age").errors().length === 2);

// ── model shared by the enforcement + two-vocabulary sections ────────────────
class ValidatedPerson extends BaseModel {
  static tableName = "validation_person";
  static fields = {
    id:   { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, minLength: 2, maxLength: 5 },
    age:  { type: "integer" as const, min: 0, max: 65 },
    code: { type: "string" as const, pattern: "^[0-9]+$" },
  };
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), "tina4-validation-"));
  const db = await initDatabase({ url: `sqlite:///${join(tmpDir, "validation.db")}` });
  const adapter = getAdapter();

  // ── 2. ORM save() ENFORCES field validation and writes NOTHING ────────────
  console.log("\n--- ORM save() enforcement (real SQLite, writes nothing) ---");
  await ValidatedPerson.createTable();

  async function rowCount(): Promise<number> {
    const r = await adapterQuery(adapter, `SELECT COUNT(*) AS c FROM "validation_person"`);
    return Number((r?.[0] as { c: number })?.c ?? -1);
  }
  async function clearTable(): Promise<void> {
    await adapterExecute(adapter, `DELETE FROM "validation_person"`);
  }

  await clearTable();
  {
    const saved = await new ValidatedPerson({ age: 30, code: "123" }).save(); // name missing
    check("a required violation makes save return false and writes nothing",
      saved === false && (await rowCount()) === 0);
  }
  await clearTable();
  {
    const saved = await new ValidatedPerson({ name: "Alexander", age: 30, code: "123" }).save();
    check("an over length value makes save return false and writes nothing",
      saved === false && (await rowCount()) === 0);
  }
  await clearTable();
  {
    const saved = await new ValidatedPerson({ name: "Al", age: 999, code: "123" }).save();
    check("an out of range value makes save return false and writes nothing",
      saved === false && (await rowCount()) === 0);
  }
  await clearTable();
  {
    const saved = await new ValidatedPerson({ name: "Al", age: 30, code: "abc" }).save();
    check("a pattern violation makes save return false and writes nothing",
      saved === false && (await rowCount()) === 0);
  }
  await clearTable();
  {
    const saved = await new ValidatedPerson({ name: "Al", age: 30, code: "123" }).save();
    check("a valid model saves and writes one row",
      saved !== false && (await rowCount()) === 1);
  }

  // ── 3. one canonical vocabulary across BOTH validators ────────────────────
  console.log("\n--- unified message vocabulary (request == ORM) ---");

  // Build an ORM instance violating exactly one rule; its validate() returns the
  // single message that must byte-match the request Validator's message.
  const ormMsg = (o: ValidatedPerson): string => o.validate()[0];

  check("required emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ age: 30, code: "123" })) ===
      new Validator({}).required("name").errors()[0].message &&
    ormMsg(new ValidatedPerson({ age: 30, code: "123" })) === "name is required");

  check("min length emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ name: "A", age: 30, code: "123" })) ===
      new Validator({ name: "A" }).minLength("name", 2).errors()[0].message &&
    ormMsg(new ValidatedPerson({ name: "A", age: 30, code: "123" })) === "name must be at least 2 characters");

  check("max length emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ name: "Alexander", age: 30, code: "123" })) ===
      new Validator({ name: "Alexander" }).maxLength("name", 5).errors()[0].message &&
    ormMsg(new ValidatedPerson({ name: "Alexander", age: 30, code: "123" })) === "name must be at most 5 characters");

  check("min emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ name: "Al", age: -5, code: "123" })) ===
      new Validator({ age: -5 }).min("age", 0).errors()[0].message &&
    ormMsg(new ValidatedPerson({ name: "Al", age: -5, code: "123" })) === "age must be at least 0");

  check("max emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ name: "Al", age: 999, code: "123" })) ===
      new Validator({ age: 999 }).max("age", 65).errors()[0].message &&
    ormMsg(new ValidatedPerson({ name: "Al", age: 999, code: "123" })) === "age must be at most 65");

  check("regex emits the same canonical message from both validators",
    ormMsg(new ValidatedPerson({ name: "Al", age: 30, code: "abc" })) ===
      new Validator({ code: "abc" }).regex("code", "^[0-9]+$").errors()[0].message &&
    ormMsg(new ValidatedPerson({ name: "Al", age: 30, code: "abc" })) === "code does not match the required format");

  closeDatabase();

  // ── 4. AutoCrud PUT validates + partial-update mode (real socket + SQLite) ─
  console.log("\n--- AutoCrud PUT validation (real HTTP + real SQLite) ---");
  const db2 = await initDatabase({ url: `sqlite:///${join(tmpDir, "autocrud.db")}` });
  const adapter2 = getAdapter();
  await adapterExecute(adapter2,
    `CREATE TABLE "vpeople" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, age INTEGER)`);
  await adapterExecute(adapter2,
    `INSERT INTO "vpeople" (name, email, age) VALUES ('Al', 'al@example.com', 30)`);

  const model: DiscoveredModel = {
    filePath: "src/models/VPerson.ts",
    definition: {
      tableName: "vpeople",
      fields: {
        id:    { type: "integer", primaryKey: true, autoIncrement: true },
        name:  { type: "string", required: true, maxLength: 5 },
        email: { type: "string", required: true },
        age:   { type: "integer", min: 0, max: 65 },
      },
    },
  };
  const crud = generateCrudRoutes([model]);
  const putHandler = crud.find((r) => r.method === "PUT" && r.pattern === "/api/vpeople/{id}")!.handler;
  const postHandler = crud.find((r) => r.method === "POST" && r.pattern === "/api/vpeople")!.handler;

  async function invoke(
    handler: (req: Tina4Request, res: Tina4Response) => unknown,
    opts: { method: string; params?: Record<string, string>; body?: unknown },
  ): Promise<{ statusCode: number; body: any }> {
    const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const treq = req as unknown as Tina4Request;
      treq.params = opts.params ?? {};
      treq.query = {};
      treq.body = raw ? JSON.parse(raw) : {}; // real bytes off the socket, parsed
      const response = createResponse(res);
      try { await handler(treq, response); }
      catch (err) { if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ error: String(err) })); } }
      if (!res.writableEnded) res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const payload = opts.body === undefined ? "" : JSON.stringify(opts.body);
    try {
      return await new Promise((resolve, reject) => {
        const rq = http.request(
          { host: "127.0.0.1", port: addr.port, path: "/", method: opts.method,
            headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
          (resp) => {
            const cc: Buffer[] = [];
            resp.on("data", (c) => cc.push(c as Buffer));
            resp.on("end", () => {
              const text = Buffer.concat(cc).toString("utf8");
              let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* raw */ }
              resolve({ statusCode: resp.statusCode ?? 0, body: parsed });
            });
          });
        rq.on("error", reject);
        if (payload) rq.write(payload);
        rq.end();
      });
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  }

  {
    const { statusCode, body } = await invoke(putHandler, { method: "PUT", params: { id: "1" }, body: { name: "Alexander" } });
    const rows = await adapterQuery(adapter2, `SELECT name FROM "vpeople" WHERE id = 1`);
    check("autocrud put rejects an invalid body with 422",
      statusCode === 422 && body?.error === "Validation failed" &&
      (rows?.[0] as { name: string })?.name === "Al", // untouched — no write
      JSON.stringify({ statusCode, body }));
  }
  {
    // Only `age` provided: with the partial-update mode wired, the absent
    // required name/email are NOT re-required, so a valid partial update passes.
    const { statusCode } = await invoke(putHandler, { method: "PUT", params: { id: "1" }, body: { age: 40 } });
    const rows = await adapterQuery(adapter2, `SELECT age FROM "vpeople" WHERE id = 1`);
    check("autocrud put allows a partial update without requiring unrelated fields",
      statusCode === 200 && Number((rows?.[0] as { age: number })?.age) === 40,
      String(statusCode));
  }
  {
    const { statusCode, body } = await invoke(postHandler, { method: "POST", body: { name: "Alexander", email: "a@b.co" } });
    check("autocrud post still rejects an invalid body with 422",
      statusCode === 422 && body?.error === "Validation failed", JSON.stringify({ statusCode, body }));
  }

  closeDatabase();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\nvalidation contract: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
