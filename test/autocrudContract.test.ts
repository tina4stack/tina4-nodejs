// Shared contract suite for feature 27 -- AutoCrud (REST from ORM models).
//
// Fixture: tina4-documentation/plan/v3/fixtures/autocrud_contract.json
// Decisions: CRUD-DEC-01 (a consistent 422 with field errors on an invalid
// create/update -- Node already returned 422 here) + CRUD-DEC-02 (allow-list
// writable columns -- guard is_deleted, strip the PK on create/update -- and
// add wire tests, CRUD-WRITE-TESTS).
//
// WHAT THIS PROVES, and why it is the first AutoCrud test in this repo to do
// so: every existing autoCrud*.test.ts / validationContract.test.ts file
// takes `route.handler` straight off generateCrudRoutes() and calls it
// directly -- bypassing the Router and the real auth gate entirely (grep
// confirms none of them mint a token or send an Authorization header). This
// file instead boots a REAL server via the REAL startServer() (mirroring
// secureByDefault.test.ts's pattern), with a REAL model file discovered from
// a REAL src/models/ directory on disk, so AutoCrud's generated routes are
// wired onto the SAME Router enforceRouteAuth() gates in production. Every
// request below is a genuine node:http socket round trip against a real
// SQLite database, with a REAL JWT minted via getToken(). NO MOCKS anywhere
// in this chain.
//
// Run with: npx tsx test/autocrudContract.test.ts

import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getToken } from "../packages/core/src/auth.ts";
import { startServer } from "../packages/core/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const SECRET = "autocrud-contract-test-secret";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

// ── A real project on disk: a real src/models/ file, a real SQLite db ──────
const root = mkdtempSync(join(tmpdir(), "tina4-autocrud-contract-"));
mkdirSync(join(root, "src/models"), { recursive: true });
mkdirSync(join(root, "src/routes"), { recursive: true });

// Absolute path to the framework's own ORM source, so the model file (which
// lives OUTSIDE the repo, in a temp dir) can import BaseModel regardless of
// its own location -- the same "a real file on disk" pattern
// secureByDefault.test.ts uses for route files, extended to carry an import.
const ORM_SRC = fileURLToPath(new URL("../packages/orm/src", import.meta.url));

// Soft-delete enabled + is_deleted DECLARED as a real field -- the worst
// case for CRUD-MASS-ASSIGNMENT (is_deleted is a genuine writable-looking
// column, not merely framework-injected DDL a client would never guess).
// Secure-by-default: no `static autoCrud` public flag, no public:true
// anywhere -- startServer's auto-wiring (crudEligibleModels + generateCrudRoutes
// with no options) always leaves writes gated.
writeFileSync(
  join(root, "src/models/CrudItem.ts"),
  `import { BaseModel } from "file://${ORM_SRC}/baseModel.js";

export default class CrudItem extends BaseModel {
  static tableName = "crud_item";
  static autoCrud = true;
  static softDelete = true;
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 20 },
    is_deleted: { type: "integer" as const, default: 0 },
  };
}
`,
);

interface Result {
  status: number;
  json: any;
  text: string;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON -- leave json null, text still available
        }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const PORT = 3919;

async function main() {
  const server = await startServer({
    port: PORT,
    routesDir: join(root, "src/routes"),
    modelsDir: join(root, "src/models"),
    staticDir: join(root, "public"),
    database: { type: "sqlite", path: join(root, "autocrud.db") },
  });

  const call = (m: string, p: string, h: Record<string, string> = {}, b?: unknown): Promise<Result> =>
    request(
      PORT,
      m,
      p,
      { "content-type": "application/json", ...h },
      b !== undefined ? JSON.stringify(b) : undefined,
    );

  try {
    // ── tokenless_write_returns_401 ──────────────────────────────────────
    {
      const post = await call("POST", "/api/crud_item", {}, { name: "no-token" });
      assert(
        "tokenless_write_returns_401: POST without a token returns 401",
        post.status === 401,
        `status=${post.status} body=${post.text}`,
      );

      const put = await call("PUT", "/api/crud_item/1", {}, { name: "no-token" });
      assert(
        "tokenless_write_returns_401: PUT without a token returns 401",
        put.status === 401,
        `status=${put.status} body=${put.text}`,
      );

      const del = await call("DELETE", "/api/crud_item/1");
      assert(
        "tokenless_write_returns_401: DELETE without a token returns 401",
        del.status === 401,
        `status=${del.status} body=${del.text}`,
      );
    }

    // getToken's 2-arg back-compat form: the second numeric arg is
    // expiresIn IN MINUTES (not a secret) -- 3600 minutes is comfortably
    // longer than this suite's runtime.
    const token = getToken({ sub: "autocrud-contract-tester" }, 3600);
    const authed = { Authorization: `Bearer ${token}` };

    // ── valid_authenticated_post_returns_201 ─────────────────────────────
    {
      const r = await call("POST", "/api/crud_item", authed, { name: "widget-1" });
      assert(
        "valid_authenticated_post_returns_201: status is 201",
        r.status === 201,
        `status=${r.status} body=${r.text}`,
      );
      assert(
        "valid_authenticated_post_returns_201: created row echoes name",
        r.json?.data?.name === "widget-1",
        JSON.stringify(r.json),
      );
      assert(
        "valid_authenticated_post_returns_201: id assigned",
        r.json?.data?.id !== undefined && r.json?.data?.id !== null,
        JSON.stringify(r.json),
      );
    }

    // ── invalid_post_returns_422_with_field_errors ───────────────────────
    {
      const r = await call("POST", "/api/crud_item", authed, {});
      assert(
        "invalid_post_returns_422_with_field_errors: status is 422",
        r.status === 422,
        `status=${r.status} body=${r.text}`,
      );
      const errs = Array.isArray(r.json?.errors) ? r.json.errors : [];
      assert(
        "invalid_post_returns_422_with_field_errors: field errors name the missing field",
        errs.some((e: any) => String(e?.field ?? e).includes("name")),
        JSON.stringify(r.json),
      );
    }

    // ── invalid_put_is_rejected ───────────────────────────────────────────
    {
      const created = await call("POST", "/api/crud_item", authed, { name: "put-target" });
      const id = created.json?.data?.id;

      const r = await call("PUT", `/api/crud_item/${id}`, authed, { name: "x".repeat(100) });
      assert(
        "invalid_put_is_rejected: status is 422",
        r.status === 422,
        `status=${r.status} body=${r.text}`,
      );

      const check = await call("GET", `/api/crud_item/${id}`);
      assert(
        "invalid_put_is_rejected: row unchanged in the DB",
        check.json?.data?.name === "put-target",
        JSON.stringify(check.json),
      );
    }

    // ── mass_assignment_is_blocked ───────────────────────────────────────
    {
      const r = await call("POST", "/api/crud_item", authed, {
        name: "mass-assign",
        is_deleted: 1,
        id: 999999,
      });
      assert(
        "mass_assignment_is_blocked: create with a guarded body still succeeds (201)",
        r.status === 201,
        `status=${r.status} body=${r.text}`,
      );
      const id = r.json?.data?.id;
      assert(
        "mass_assignment_is_blocked: client-supplied PK on create is NOT honoured",
        id !== 999999,
        `id=${id}`,
      );

      const row1 = await call("GET", `/api/crud_item/${id}`);
      assert(
        "mass_assignment_is_blocked: is_deleted not written on create",
        Number(row1.json?.data?.is_deleted) === 0,
        JSON.stringify(row1.json),
      );

      const put = await call("PUT", `/api/crud_item/${id}`, authed, { is_deleted: 1 });
      assert(
        "mass_assignment_is_blocked: PUT carrying only is_deleted is a benign no-op (200)",
        put.status === 200,
        `status=${put.status} body=${put.text}`,
      );

      const row2 = await call("GET", `/api/crud_item/${id}`);
      assert(
        "mass_assignment_is_blocked: is_deleted not written on update",
        Number(row2.json?.data?.is_deleted) === 0,
        JSON.stringify(row2.json),
      );
    }

    // ── list_is_the_seven_key_envelope ───────────────────────────────────
    {
      const r = await call("GET", "/api/crud_item");
      assert("list_is_the_seven_key_envelope: status 200", r.status === 200, `status=${r.status}`);
      const keys = Object.keys(r.json ?? {}).sort();
      const expected = ["limit", "offset", "page", "per_page", "records", "total", "total_pages"];
      assert(
        "list_is_the_seven_key_envelope: exactly the seven ADR-0043 keys",
        JSON.stringify(keys) === JSON.stringify(expected),
        JSON.stringify(keys),
      );
      assert(
        "list_is_the_seven_key_envelope: total is a true COUNT, not the page size",
        typeof r.json?.total === "number" && r.json.total === 3,
        JSON.stringify(r.json),
      );
    }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
