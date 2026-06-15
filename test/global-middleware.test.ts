/**
 * Global class-based middleware registered via Router.use(SomeClass) now runs
 * on every request (parity with Python/PHP/Ruby). beforeX hooks set headers /
 * mutate the request / short-circuit; afterX hooks run after the handler.
 * Run with: npx tsx test/global-middleware.test.ts
 */
import { startServer, get, Router } from "../packages/core/src/index.ts";
import http from "node:http";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const PORT = 7191;

class PoweredBy {
  static beforePoweredBy(req: any, res: any) {
    res.header("X-Powered-By", "Tina4");
    const rid = req.header("X-Request-Id");
    if (rid) res.header("X-Response-Id", rid);
    return [req, res];
  }
}
class Gate {
  static beforeGate(req: any, res: any) {
    if ((req.url || "").includes("/blocked")) res.json({ error: "forbidden" }, 403);
    return [req, res];
  }
}

Router.use(PoweredBy);
Router.use(Gate);
get("/api/status", async (_req: any, res: any) => res.json({ ok: true }));
get("/blocked", async (_req: any, res: any) => res.json({ reached: true }));

function request(path: string): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: "127.0.0.1", port: PORT, path, headers: { "X-Request-Id": "abc123" } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: b })); },
    );
    r.on("error", reject);
  });
}

(async () => {
  const handle = await startServer({ port: PORT });
  try {
    const ok = await request("/api/status");
    assert("global beforeX runs — X-Powered-By set", ok.headers["x-powered-by"] === "Tina4", JSON.stringify(ok.headers));
    assert("global beforeX reads request header — X-Request-Id echoed", ok.headers["x-response-id"] === "abc123");
    assert("handler still runs normally", ok.status === 200 && ok.body === '{"ok":true}', ok.body);

    const blk = await request("/blocked");
    assert("beforeX can short-circuit with >= 400", blk.status === 403, String(blk.status));
    assert("short-circuited handler did NOT run", !blk.body.includes("reached"), blk.body);
  } finally {
    await handle.close();
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
