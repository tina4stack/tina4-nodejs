/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A modifier chained on any() must reach every method any() registers.
 *
 * any() stores one route per method (GET, POST, PUT, PATCH, DELETE, OPTIONS,
 * HEAD). The ref it returned used to wrap only the last of them (HEAD), so
 * `any(path, h).role("admin")` guarded HEAD alone: an anonymous GET got 200 and
 * a token without the role got 200 on all five methods.
 *
 * Part 1 drives REAL requests through a REAL startServer() with REAL tokens, for
 * each way of registering an any() route (Router.any, the top-level any(),
 * Router.add("ANY"), and RouteGroup.any). Part 2 checks every modifier the ref
 * exposes, per method, through router.match().
 */
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToken } from "../packages/core/src/auth.ts";
import { startServer, Router, any } from "../packages/core/src/index.ts";

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

const SECRET = "any-modifiers-secret-0123456789ab";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

const PORT = 3727;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const root = mkdtempSync(join(tmpdir(), "tina4-any-mod-"));
mkdirSync(join(root, "src/routes"), { recursive: true });

const ok = async (_req: any, res: any) => res.json({ ok: true });

// ── Part 1 routes, on the default router (served by startServer) ──
Router.any("/anymod/role", ok).role("admin");
Router.any("/anymod/can", ok).can("posts.delete");
Router.any("/anymod/secure", ok).secure();
Router.any("/anymod/open", ok).noAuth();
any("/anymod/fn-role", ok).role("admin");
Router.add("ANY", "/anymod/add-role", ok).role("admin");
Router.group("/anymod/g", (g) => {
  g.any("/role", ok).role("admin");
});

function request(path: string, method: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = method === "GET" || method === "HEAD" || method === "OPTIONS" ? undefined : "{}";
    const req = http.request({
      hostname: "127.0.0.1", port: PORT, path, method,
      headers: {
        "Content-Type": "application/json",
        ...(body === undefined ? {} : { "Content-Length": String(body.length) }),
        ...headers,
      },
    }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode!));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function bearer(payload: Record<string, unknown>): Record<string, string> {
  return { Authorization: `Bearer ${getToken(payload)}` };
}

async function codes(path: string, headers: Record<string, string> = {}): Promise<string> {
  const out: string[] = [];
  for (const m of METHODS) out.push(`${m}=${await request(path, m, headers)}`);
  return out.join(" ");
}

function every(code: number): string {
  return METHODS.map((m) => `${m}=${code}`).join(" ");
}

const server = await startServer({
  port: PORT,
  host: "127.0.0.1",
  noBrowser: true,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});

const user = bearer({ sub: "u", roles: ["user"], permissions: ["posts.read"] });
const admin = bearer({ sub: "u", roles: ["admin"], permissions: ["posts.delete"] });

try {
  for (const path of ["/anymod/role", "/anymod/fn-role", "/anymod/add-role", "/anymod/g/role"]) {
    let got = await codes(path);
    assert(`${path}: role guard gives 401 to anonymous on every method`, got === every(401), got);
    got = await codes(path, user);
    assert(`${path}: role guard gives 403 to a token without the role on every method`, got === every(403), got);
    got = await codes(path, admin);
    assert(`${path}: role guard admits the role on every method`, got === every(200), got);
  }

  let got = await codes("/anymod/can", user);
  assert("any().can(): 403 without the permission on every method", got === every(403), got);
  got = await codes("/anymod/can", admin);
  assert("any().can(): 200 with the permission on every method", got === every(200), got);

  got = await codes("/anymod/secure");
  assert("any().secure(): 401 anonymous on every method", got === every(401), got);
  got = await codes("/anymod/secure", user);
  assert("any().secure(): 200 with a valid token on every method", got === every(200), got);

  got = await codes("/anymod/open");
  assert("any().noAuth(): public on every method, writes included", got === every(200), got);
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

// ── Part 2: every modifier the ref exposes, per method, via match() ──
const mw = async (_req: any, _res: any, next: any) => next();
const r = new Router();
r.any("/m/secure", ok).secure();
r.any("/m/noauth", ok).noAuth();
r.any("/m/nocsrf", ok).noCsrf();
r.any("/m/cache", ok).cache();
r.any("/m/mw", ok).middleware(mw);
r.any("/m/role", ok).role("admin").role("editor");
r.any("/m/can", ok).can("posts.delete");
r.group("/g", (g) => { g.any("/m", ok).role("admin"); });

for (const m of METHODS) {
  const at = (p: string) => r.match(m, p);
  assert(`match ${m}: secure() reached`, at("/m/secure")?.secure === true);
  assert(`match ${m}: noAuth() reached`, at("/m/noauth")?.noAuth === true);
  assert(`match ${m}: noCsrf() reached`, at("/m/nocsrf")?.noCsrf === true);
  assert(`match ${m}: cache() reached`, at("/m/cache")?.cached === true);
  assert(`match ${m}: middleware() reached`, (at("/m/mw")?.middlewares ?? []).includes(mw));
  assert(`match ${m}: stacked role() reached`,
    JSON.stringify(at("/m/role")?.requiredRoles) === JSON.stringify([["admin"], ["editor"]]),
    JSON.stringify(at("/m/role")?.requiredRoles));
  assert(`match ${m}: can() reached`,
    JSON.stringify(at("/m/can")?.requiredPerms) === JSON.stringify([["posts.delete"]]));
  assert(`match ${m}: group any().role() reached`,
    JSON.stringify(at("/g/m")?.requiredRoles) === JSON.stringify([["admin"]]));
}

// The ref must not leak a modifier onto a route it does not own.
const r2 = new Router();
r2.get("/x", ok);
r2.any("/y", ok).role("admin");
assert("a sibling route keeps no role", r2.match("GET", "/x")?.requiredRoles === undefined);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
