/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * #342 — the auth-gate 401 and a throwing middleware's 500 go through the SAME
 * negotiated error renderer as 404/403/500 (ERR-DEC-02).
 *
 * The defect: a browser that hit a protected route without a valid token, or a
 * route whose middleware hook threw, got a raw JSON body instead of the HTML
 * error PAGE every other framework error already negotiated. Fixed: a browser
 * gets errors/{401,500}.twig; an API client gets the JSON envelope
 * {error, code, message, status, request_id}. The 500 keeps CWE-209.
 *
 * Driven through a REAL server (startServer) over a REAL socket - NO mocks.
 * Same case names in all four:
 *   tina4-python/tests/test_error_negotiation_401_500.py
 *   tina4-php/tests/ErrorNegotiation401Middleware500Test.php
 *   tina4-ruby/spec/error_negotiation_401_middleware500_spec.rb
 */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startServer, MiddlewareRunner } from "../packages/core/src/index.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const SECRET = "ERRNEG342-secret-stack-detail-do-not-leak";

function req(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers, agent: false },
      (rs) => {
        let body = "";
        rs.on("data", (c) => (body += c));
        rs.on("end", () => resolve({ status: rs.statusCode ?? 0, headers: rs.headers, body }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

// A class middleware whose beforeX hook throws — the #342 500 path.
class ErrNeg342Throwing {
  static beforeExplode(): never {
    throw new Error(`middleware exploded: ${SECRET}`);
  }
}

async function main(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), "tina4-errneg342-"));
  mkdirSync(join(base, "src", "routes"), { recursive: true });
  mkdirSync(join(base, "public"), { recursive: true });

  const prevDebug = process.env.TINA4_DEBUG;
  delete process.env.TINA4_DEBUG;
  const prevSecret = process.env.TINA4_SECRET;
  process.env.TINA4_SECRET = "err-neg-342-secret-0123456789abcdef";
  delete process.env.TINA4_API_KEY;

  MiddlewareRunner.reset();

  const port = await freePort();
  const server = await startServer({
    port,
    basePath: base,
    routesDir: join(base, "src", "routes"),
    modelsDir: join(base, "src", "models"),
    staticDir: join(base, "public"),
  });

  // A secure-by-default route (GET + .secure()) for the 401 gate.
  server.router.get("/errneg342-secure", async (_req: any, res: any) => res.json({ secret: true }, 200)).secure();
  // A public GET whose before-middleware throws for the 500 path.
  server.router
    .get("/errneg342-boom", async (_req: any, res: any) => res.json({ never: true }, 200))
    .middleware(ErrNeg342Throwing);

  try {
    // ----------------------------------------------------- 401 auth gate
    {
      const rHtml = await req(port, "/errneg342-secure", { Accept: "text/html" });
      assert("401 browser: status", rHtml.status === 401, String(rHtml.status));
      assert("401 browser: content-type html", String(rHtml.headers["content-type"]).includes("text/html"));
      assert("401 browser: error page body", rHtml.body.includes("error-code") && rHtml.body.includes(">401<"), rHtml.body.slice(0, 120));

      const rJson = await req(port, "/errneg342-secure", { Accept: "application/json" });
      assert("401 api: status", rJson.status === 401);
      assert("401 api: content-type json", String(rJson.headers["content-type"]).includes("application/json"));
      const body = JSON.parse(rJson.body);
      assert("401 api: error=true", body.error === true);
      assert("401 api: code=UNAUTHORIZED", body.code === "UNAUTHORIZED", JSON.stringify(body));
      assert("401 api: status field", body.status === 401);
      assert("401 api: request_id", !!body.request_id);
    }

    // --------------------------------------------- middleware-throw 500
    {
      const rHtml = await req(port, "/errneg342-boom", { Accept: "text/html" });
      assert("500 browser: status", rHtml.status === 500, String(rHtml.status));
      assert("500 browser: content-type html", String(rHtml.headers["content-type"]).includes("text/html"));
      assert("500 browser: error page body", rHtml.body.includes('"error-code">500<'), rHtml.body.slice(0, 120));
      assert("500 browser: no exception text (CWE-209)", !rHtml.body.includes(SECRET));

      const rJson = await req(port, "/errneg342-boom", { Accept: "application/json" });
      assert("500 api: status", rJson.status === 500);
      assert("500 api: content-type json", String(rJson.headers["content-type"]).includes("application/json"));
      const body = JSON.parse(rJson.body);
      assert("500 api: error=true", body.error === true);
      assert("500 api: code=INTERNAL_SERVER_ERROR", body.code === "INTERNAL_SERVER_ERROR", JSON.stringify(body));
      assert("500 api: status field", body.status === 500);
      assert("500 api: request_id", !!body.request_id);
      assert("500 api: no exception text (CWE-209)", !JSON.stringify(body).includes(SECRET));
    }
  } finally {
    server.close();
    MiddlewareRunner.reset();
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    if (prevDebug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = prevDebug;
    if (prevSecret === undefined) delete process.env.TINA4_SECRET; else process.env.TINA4_SECRET = prevSecret;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
