/**
 * `req.user` carries the DECODED PAYLOAD, not a boolean -- proven for REAL.
 *
 * The bug this file exists to regress: `validToken()` was changed to return a
 * bool while the gate still needed the claims, so `req.user` could silently
 * become `true` instead of the payload object. A handler doing
 * `req.user.userId` then reads `undefined` and every authorisation decision
 * downstream is made on nothing.
 *
 * WHAT THIS FILE USED TO BE: it declared its own `simulateAuthEnforcement()`
 * and asserted that THAT returned a payload -- a copy of the production block,
 * with the copy under test. A copy can be correct while the original is not,
 * which is exactly the state the described bug was in. Its header pinned the
 * copy to "server.ts lines 788-800"; test/secureByDefault.test.ts pinned its
 * copy of the SAME block to "lines 687-700". Two different line ranges for one
 * block is direct evidence the copies had already drifted from the original and
 * from each other. Both ranges were stale: the real gate is
 * packages/core/src/authGate.ts and `server.ts` no longer contains it.
 *
 * WHAT IT IS NOW: a REAL server, a REAL http.request, and a REAL route handler
 * that echoes `req.user` into the response body. The assertion reads the JSON
 * the client actually received, so `req.user === true` shows up as `true` on
 * the wire and fails. That is the measurement the bug required.
 *
 * Run: npx tsx test/routerAuthPayload.test.ts
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "../packages/core/src/router.ts";
import { getToken } from "../packages/core/src/auth.ts";
import { startServer } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, RouteHandler } from "../packages/core/src/types.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
  }
}

const SECRET = "test-router-auth-secret";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

// Used only for the real-Router flag assertions (never dispatched).
const handler: RouteHandler = async (_req: Tina4Request, res: Tina4Response) => {
  res({ ok: true }, 200);
};

console.log("=== Router auth payload (REAL server, REAL sockets) ===\n");

const root = mkdtempSync(join(tmpdir(), "tina4-routerauth-"));
mkdirSync(join(root, "src/routes/api/data"), { recursive: true });
mkdirSync(join(root, "src/routes/api/open"), { recursive: true });
writeFileSync(join(root, "package.json"), '{"type":"module"}');

// The handler reports the TYPE of req.user as well as its value, so the exact
// regression (`req.user === true`) is distinguishable from "payload missing".
const echoUser =
  "export default async function (req: any, res: any) {\n" +
  "  res.json({ ok: true, userType: typeof req.user, user: req.user ?? null });\n" +
  "}\n";
writeFileSync(join(root, "src/routes/api/data/post.ts"), echoUser);
writeFileSync(join(root, "src/routes/api/open/get.ts"), echoUser);

interface Result { status: number; json: any; body: string }

function request(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, json, body: text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const PORT = 3731;
const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});
const call = (m: string, p: string, h: Record<string, string> = {}) => request(PORT, m, p, h);

try {
  // ── 1. POST without Bearer returns 401 ────────────────────────────────────
  console.log("-- Auth enforcement: missing token --");
  {
    const router = new Router();
    router.post("/api/data", handler);
    const match = router.match("POST", "/api/data");
    assert("1a. POST route exists", match !== null);
    assert("1b. POST route is secure by default", match?.secure === true);

    const r = await call("POST", "/api/data");
    assert("1. POST without Bearer returns a real 401", r.status === 401, `status=${r.status}`);
    assert("1c. the real handler never ran", r.json?.ok === undefined, `body=${r.body}`);
  }

  // ── 2. Valid Bearer: 200 AND req.user is the payload OBJECT ───────────────
  console.log("\n-- Auth enforcement: valid token --");
  {
    const token = getToken({ userId: 42 }, 3600);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${token}` });
    assert("2. POST with valid Bearer returns a real 200", r.status === 200,
      `status=${r.status} body=${r.body}`);

    // THE regression assertion, now made against the wire. `req.user = true`
    // serialises as `"userType":"boolean"` and fails here.
    assert("2a. req.user is an object on the wire (not a boolean)",
      r.json?.userType === "object" && r.json?.user !== null,
      `userType=${r.json?.userType} user=${JSON.stringify(r.json?.user)}`);
    assert("2b. req.user.userId === 42 (not true)", r.json?.user?.userId === 42,
      `got ${JSON.stringify(r.json?.user)}`);
  }

  // ── 3. Invalid Bearer returns 401 ─────────────────────────────────────────
  console.log("\n-- Auth enforcement: invalid token --");
  {
    const r = await call("POST", "/api/data", { Authorization: "Bearer garbage.token.here" });
    assert("3. POST with invalid Bearer returns a real 401", r.status === 401, `status=${r.status}`);
    assert("3a. the real handler never ran", r.json?.ok === undefined, `body=${r.body}`);
  }

  // ── 4. Open GET: 200, and no payload is invented ──────────────────────────
  //     NEGATIVE CONTROL -- a change that 401s everything fails here.
  console.log("\n-- Open GET route --");
  {
    const router = new Router();
    router.get("/api/open", handler);
    const match = router.match("GET", "/api/open");
    assert("4a. GET route has no secure flag by default", match?.secure === undefined);

    const r = await call("GET", "/api/open");
    assert("4. GET without .secure() returns a real 200", r.status === 200,
      `status=${r.status} body=${r.body}`);
    assert("4b. no user payload is attached on a public route", r.json?.user === null,
      `got ${JSON.stringify(r.json?.user)}`);
  }

  // ── 5. Expired token returns 401 ──────────────────────────────────────────
  console.log("\n-- Edge cases --");
  {
    const expired = getToken({ userId: 1 }, -1);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${expired}` });
    assert("5. Expired Bearer on POST returns a real 401", r.status === 401, `status=${r.status}`);
  }

  // ── 6. Every claim survives the round trip ────────────────────────────────
  {
    const token = getToken({ userId: 99, role: "admin", org: "tina4" }, 3600);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${token}` });
    assert("6. req.user carries all claims (userId)", r.json?.user?.userId === 99,
      `got ${JSON.stringify(r.json?.user)}`);
    assert("6b. req.user carries all claims (role)", r.json?.user?.role === "admin");
    assert("6c. req.user carries all claims (org)", r.json?.user?.org === "tina4");
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
