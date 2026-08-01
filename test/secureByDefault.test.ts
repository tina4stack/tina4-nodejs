/**
 * Secure-by-default route behaviour, driven for REAL.
 *
 * Write methods (POST, PUT, PATCH, DELETE) are secure by default -- they
 * require a valid Bearer token unless the route opts out. GET is NOT secure by
 * default but can be made secure explicitly.
 *
 * WHAT THIS FILE USED TO BE: the Router-flag half was genuinely real, but the
 * enforcement half ran through an in-test `simulateAuthEnforcement()` whose
 * own header said it replicated "the auth enforcement logic from server.ts
 * (lines 687-700)". That line reference was already stale -- the real gate now
 * lives in packages/core/src/authGate.ts and `server.ts` contains no such
 * block. A secure-by-default regression in the real gate could not fail this
 * file, because the file tested its own copy. (test/routerAuthPayload.test.ts
 * cited a DIFFERENT line range, 788-800, for the same block: direct evidence
 * the copies had drifted from the original and from each other.)
 *
 * WHAT IT IS NOW: the Router-flag assertions stay (they exercise the real
 * Router and are the reason a flag regression is caught at the routing layer),
 * and every status-code assertion is a REAL http.request against a REAL server
 * started by the REAL startServer(). 401 vs 200 is read off the socket.
 *
 * Run with: npx tsx test/secureByDefault.test.ts
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

const SECRET = "secure-test-secret";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

// Handler used only for the Router-flag assertions (never dispatched).
const handler: RouteHandler = async (_req: Tina4Request, res: Tina4Response) => {
  res({ ok: true }, 200);
};

console.log("=== Secure-by-Default (REAL server, REAL sockets) ===\n");

// ── A real project on disk ──────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "tina4-securedefault-"));
mkdirSync(join(root, "src/routes/api/data"), { recursive: true });
mkdirSync(join(root, "src/routes/api/public"), { recursive: true });
mkdirSync(join(root, "src/routes/api/private"), { recursive: true });
mkdirSync(join(root, "src/routes/api/open"), { recursive: true });
mkdirSync(join(root, "src/routes/api/item"), { recursive: true });
writeFileSync(join(root, "package.json"), '{"type":"module"}');

const echo = "export default async function (req: any, res: any) {\n"
  + "  res.json({ ok: true, user: req.user ?? null });\n"
  + "}\n";

// Write methods on /api/data + /api/item: secure by default, nothing declared.
for (const method of ["post", "put", "patch", "delete"]) {
  writeFileSync(join(root, `src/routes/api/data/${method}.ts`), echo);
  writeFileSync(join(root, `src/routes/api/item/${method}.ts`), echo);
}
// A write route that explicitly opts OUT (the real `noAuth` escape hatch that
// routeDiscovery.ts:74 threads into the router).
writeFileSync(join(root, "src/routes/api/public/post.ts"), "export const noAuth = true;\n" + echo);
// A GET explicitly made secure.
writeFileSync(join(root, "src/routes/api/private/get.ts"), "export const secure = true;\n" + echo);
// A plain GET -- public, the negative control.
writeFileSync(join(root, "src/routes/api/open/get.ts"), echo);

interface Result { status: number; headers: http.IncomingHttpHeaders; json: any; body: string }

function request(
  port: number, method: string, path: string, headers: Record<string, string> = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, headers: res.headers, json, body: text });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const PORT = 3721;
const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});
const call = (m: string, p: string, h: Record<string, string> = {}) => request(PORT, m, p, h);

try {
  // ── Write methods are secure by default ───────────────────────────────────
  console.log("-- Write methods (secure by default) --");
  {
    // Routing-layer half: the REAL Router applies the write gate.
    const router = new Router();
    router.post("/api/data", handler);
    const match = router.match("POST", "/api/data");
    assert("13a. POST route is found", match !== null);
    assert("13b. POST route has secure=true by default", match?.secure === true);

    // Wire half: a REAL tokenless POST really is rejected.
    const r = await call("POST", "/api/data");
    assert("13. POST without Bearer returns a real 401", r.status === 401, `status=${r.status}`);
  }

  {
    const token = getToken({ userId: 42 }, 3600);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${token}` });
    assert("14. POST with valid Bearer returns a real 200", r.status === 200,
      `status=${r.status} body=${r.body}`);
    assert("14b. User payload reaches the real handler", r.json?.user?.userId === 42,
      `got ${JSON.stringify(r.json?.user)}`);
  }

  // ── noAuth override ───────────────────────────────────────────────────────
  console.log("\n-- noAuth override --");
  {
    const router = new Router();
    router.post("/api/public", handler).noAuth();
    const match = router.match("POST", "/api/public");
    assert("15a. noAuth flag is set on the real Router", match?.noAuth === true);

    const r = await call("POST", "/api/public");
    assert("15. POST with noAuth returns a real 200 without a token", r.status === 200,
      `status=${r.status} body=${r.body}`);
  }

  // ── GET security ──────────────────────────────────────────────────────────
  console.log("\n-- GET security --");
  {
    const router = new Router();
    router.get("/api/private", handler).secure();
    const match = router.match("GET", "/api/private");
    assert("16a. GET .secure() sets secure=true on the real Router", match?.secure === true);

    const r = await call("GET", "/api/private");
    assert("16. secure GET returns a real 401 without a token", r.status === 401, `status=${r.status}`);
  }
  {
    // NEGATIVE CONTROL. Without this, a change that 401s every request passes
    // every rejection assertion above.
    const router = new Router();
    router.get("/api/open", handler);
    const match = router.match("GET", "/api/open");
    assert("17a. GET route has secure=undefined by default", match?.secure === undefined);

    const r = await call("GET", "/api/open");
    assert("17. plain GET returns a real 200", r.status === 200, `status=${r.status} body=${r.body}`);
  }

  // ── The other write methods, on the wire ──────────────────────────────────
  console.log("\n-- Other write methods --");
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const router = new Router();
    (router as any)[method === "DELETE" ? "delete" : method.toLowerCase()]("/api/item", handler);
    const match = router.match(method, "/api/item");
    assert(`${method} is secure by default on the real Router`, match?.secure === true);

    const rejected = await call(method, "/api/item");
    assert(`${method} without Bearer returns a real 401`, rejected.status === 401,
      `status=${rejected.status}`);

    const token = getToken({ userId: 7 }, 3600);
    const allowed = await call(method, "/api/item", { Authorization: `Bearer ${token}` });
    assert(`${method} with a valid Bearer returns a real 200`, allowed.status === 200,
      `status=${allowed.status} body=${allowed.body}`);
  }

  // ── Edge cases, all on the wire ───────────────────────────────────────────
  console.log("\n-- Edge cases --");
  {
    const expired = getToken({ userId: 1 }, -1);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${expired}` });
    assert("Expired Bearer on POST returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await call("POST", "/api/data", { Authorization: "Bearer garbage.token.here" });
    assert("Invalid Bearer on POST returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    // A token signed with the WRONG secret -- the case a copy of the gate can
    // never get wrong, because the copy and the original share the same helper.
    const foreign = getToken({ userId: 99 }, "a-completely-different-secret", 3600);
    const r = await call("POST", "/api/data", { Authorization: `Bearer ${foreign}` });
    assert("Foreign-secret Bearer on POST returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    const token = getToken({ role: "admin" }, 3600);
    const r = await call("GET", "/api/private", { Authorization: `Bearer ${token}` });
    assert("Valid Bearer on secure GET returns a real 200", r.status === 200,
      `status=${r.status} body=${r.body}`);
    assert("Valid Bearer on secure GET attaches the payload", r.json?.user?.role === "admin");
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
