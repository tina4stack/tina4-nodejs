/**
 * RBAC role/permission guards — Feature 138 / ADR-0058.
 * Contract answer key: tina4-documentation/plan/v3/fixtures/rbac_contract.json.
 *
 * Every case drives a REAL request through a REAL startServer() over the loopback
 * socket, with REAL HS256 tokens minted by getToken. NO MOCKS: the guarded routes
 * are registered on the default router and served through the same authGate the
 * live server runs. role()/can() read the VERIFIED payload only; a guard implies
 * auth (no token -> 401, valid-but-unauthorised -> 403).
 */
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToken } from "../packages/core/src/auth.ts";
import { startServer, get } from "../packages/core/src/index.ts";

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

const SECRET = "rbac-contract-secret";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

const PORT = 3719;
const root = mkdtempSync(join(tmpdir(), "tina4-rbac-"));
mkdirSync(join(root, "src/routes"), { recursive: true });

const ok = async (_req: any, res: any) => res.json({ ok: true });
// GET routes (public by default) so the guard is what makes them require auth.
get("/rbac/role_admin", ok).role("admin");
get("/rbac/role_any", ok).role("admin", "editor");
get("/rbac/role_stacked", ok).role("admin").role("editor");
get("/rbac/can_delete", ok).can("posts.delete");
get("/rbac/can_users", ok).can("users.delete");

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end();
  });
}

function bearer(payload: Record<string, unknown>): Record<string, string> {
  return { Authorization: `Bearer ${getToken(payload)}` };
}

const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});

try {
  // ── rbac-role-allows ─────────────────────────────────────────
  assert("role claim allows the route",
    (await request(PORT, "/rbac/role_admin", bearer({ sub: "u", roles: ["admin"] }))) === 200);

  // ── rbac-role-denies-403 ─────────────────────────────────────
  assert("missing role is forbidden 403",
    (await request(PORT, "/rbac/role_admin", bearer({ sub: "u", roles: ["viewer"] }))) === 403);

  // ── rbac-unauthenticated-401 ─────────────────────────────────
  // No token -> 401 (unauthenticated), NOT 403. A guard implies auth.
  assert("unauthenticated guard is 401",
    (await request(PORT, "/rbac/role_admin")) === 401);

  // ── rbac-role-or-and ─────────────────────────────────────────
  assert("role list is any-of (editor)",
    (await request(PORT, "/rbac/role_any", bearer({ sub: "u", roles: ["editor"] }))) === 200);
  assert("role list is any-of (admin)",
    (await request(PORT, "/rbac/role_any", bearer({ sub: "u", roles: ["admin"] }))) === 200);
  assert("role list any-of denies a non-member",
    (await request(PORT, "/rbac/role_any", bearer({ sub: "u", roles: ["viewer"] }))) === 403);
  assert("stacked guards are all-of (both present)",
    (await request(PORT, "/rbac/role_stacked", bearer({ sub: "u", roles: ["admin", "editor"] }))) === 200);
  assert("stacked guards are all-of (one missing -> 403)",
    (await request(PORT, "/rbac/role_stacked", bearer({ sub: "u", roles: ["admin"] }))) === 403);

  // ── rbac-can-permission ──────────────────────────────────────
  assert("permission grants the route",
    (await request(PORT, "/rbac/can_delete", bearer({ sub: "u", permissions: ["posts.delete"] }))) === 200);
  assert("missing permission is forbidden 403",
    (await request(PORT, "/rbac/can_delete", bearer({ sub: "u", permissions: ["posts.read"] }))) === 403);
  assert("role alone does not satisfy a permission guard",
    (await request(PORT, "/rbac/can_delete", bearer({ sub: "u", roles: ["admin"] }))) === 403);

  // ── rbac-wildcard-grant ──────────────────────────────────────
  assert("wildcard permission grants within scope",
    (await request(PORT, "/rbac/can_delete", bearer({ sub: "u", permissions: ["posts.*"] }))) === 200);
  assert("superuser star grants everything",
    (await request(PORT, "/rbac/can_delete", bearer({ sub: "u", permissions: ["*"] }))) === 200);
  assert("wildcard does not cross scope",
    (await request(PORT, "/rbac/can_users", bearer({ sub: "u", permissions: ["posts.*"] }))) === 403);

  // ── rbac-verified-payload-only ───────────────────────────────
  // A viewer token with a spoofed X-Role: admin header is still forbidden.
  assert("spoofed role header is ignored",
    (await request(PORT, "/rbac/role_admin",
      { ...bearer({ sub: "u", roles: ["viewer"] }), "X-Role": "admin" })) === 403);

  // ── rbac-legacy-singular-role ────────────────────────────────
  assert("legacy singular role is coerced",
    (await request(PORT, "/rbac/role_admin", bearer({ sub: "u", role: "admin" }))) === 200);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
