/**
 * Feature 43 - request-id / correlation-id (Node).
 * Run with: npx tsx test/requestid.test.ts
 *
 * Real request-pipeline tests: a REAL server (startServer -> createServer(dispatch))
 * driven over a REAL socket with node:http - NO mocks. Routes are registered
 * PROGRAMMATICALLY on the live server's router so the handler and the server
 * share ONE Log instance (a file route would import @tina4/core from dist and
 * get a different Log). The logger case reads the REAL tina4.log the framework
 * wrote.
 *
 * Proves the four cross-framework invariants:
 *   1. a well-formed inbound X-Request-ID is honoured and echoed on the response;
 *   2. an absent id yields a generated id echoed on the response;
 *   3. a hostile inbound id is sanitized so it never reflects raw into the
 *      response header or a log line (over-long + illegal-charset travel over
 *      real HTTP; CR/LF cannot - a compliant HTTP client refuses to send an
 *      embedded newline - so it is proven at the sanitizer, the real guard);
 *   4. a log line written during the request carries the id (log correlation).
 *
 * Plus the Node-specific correctness property (porting capsule): two requests
 * interleaving on the one event loop keep DISTINCT ids (AsyncLocalStorage).
 */
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../packages/core/src/index.ts";
import { Log } from "../packages/core/src/logger.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** One real HTTP GET over its own socket (agent:false -> true concurrency). */
function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request(
      { hostname: "localhost", port, path, method: "GET", headers, agent: false },
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

async function main() {
  const base = join(tmpdir(), "tina4-rid-" + Date.now());
  const logDir = join(base, "logs");
  mkdirSync(join(base, "src/routes"), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(base, "package.json"), '{"type":"module"}');

  const prev = {
    debug: process.env.TINA4_DEBUG,
    out: process.env.TINA4_LOG_OUTPUT,
    rate: process.env.TINA4_RATE_LIMIT,
  };
  delete process.env.TINA4_DEBUG;        // no AI dual-port / no toolbar
  process.env.TINA4_RATE_LIMIT = "100000";
  process.env.TINA4_LOG_OUTPUT = "file"; // force the file sink even out of dev

  const port = await freePort();
  const server = await startServer({
    port,
    basePath: base,
    routesDir: join(base, "src/routes"),
    modelsDir: join(base, "src/models"),
    staticDir: join(base, "public"),
  });

  // Configure the SAME (src) Log the server + handlers use, AFTER boot so our
  // file sink wins; the /rid-log handler's line then lands in logDir/tina4.log.
  Log.configure(logDir);

  server.router.get("/rid-echo", async (_req: any, res: any) =>
    res.json({ rid: Log.getRequestId() ?? null }),
  );
  server.router.get("/rid-log", async (_req: any, res: any) => {
    Log.info("rid-log-marker");
    return res.json({ rid: Log.getRequestId() ?? null });
  });
  server.router.get("/rid-slow", async (_req: any, res: any) => {
    await new Promise((r) => setTimeout(r, 60)); // force two requests to interleave
    return res.json({ rid: Log.getRequestId() ?? null });
  });

  try {
    // 1. honour a valid inbound id
    {
      const r = await get(port, "/rid-echo", { "x-request-id": "trace-abc_123.4" });
      assert(
        "inbound id is honoured and echoed",
        r.headers["x-request-id"] === "trace-abc_123.4" && JSON.parse(r.body).rid === "trace-abc_123.4",
        `header=${String(r.headers["x-request-id"])}`,
      );
    }

    // 2. generate when absent
    {
      const r = await get(port, "/rid-echo");
      const rid = r.headers["x-request-id"];
      assert(
        "absent id is generated and echoed",
        typeof rid === "string" && ID_RE.test(rid) && JSON.parse(r.body).rid === rid,
        `header=${String(rid)}`,
      );
    }

    // 3. sanitize an over-long inbound id
    {
      const hostile = "a".repeat(500);
      const r = await get(port, "/rid-echo", { "x-request-id": hostile });
      const rid = String(r.headers["x-request-id"]);
      assert(
        "overlong id is sanitized",
        rid !== hostile && rid.length <= 128 && ID_RE.test(rid),
        `header len=${rid.length}`,
      );
    }

    // 3. sanitize an illegal-charset inbound id (chars a compliant HTTP client sends)
    {
      const hostile = "has spaces or *stars*";
      const r = await get(port, "/rid-echo", { "x-request-id": hostile });
      const rid = String(r.headers["x-request-id"]);
      assert(
        "illegal charset id is sanitized",
        rid !== hostile && ID_RE.test(rid),
        `header=${rid}`,
      );
    }

    // 3. sanitize a CR/LF inbound id. A compliant HTTP client refuses to put a
    // newline in a header value (node:http throws), so the CR/LF vector cannot
    // travel over the wire at all - it is proven at the sanitizer, the real
    // guard that runs if such a value ever reaches it (a folding proxy, a
    // non-HTTP caller). Real function, mutation-provable.
    {
      assert(
        "crlf id is sanitized",
        Log.sanitizeRequestId("abc\r\nSet-Cookie: x=1") === undefined &&
          Log.sanitizeRequestId("abc\ninject") === undefined &&
          Log.sanitizeRequestId("abc\rinject") === undefined,
      );
    }

    // Node porting capsule: concurrent requests keep DISTINCT ids (AsyncLocalStorage)
    {
      const [a, b] = await Promise.all([
        get(port, "/rid-slow", { "x-request-id": "aaa-111" }),
        get(port, "/rid-slow", { "x-request-id": "bbb-222" }),
      ]);
      const ra = JSON.parse(a.body).rid;
      const rb = JSON.parse(b.body).rid;
      assert(
        "two concurrent requests keep distinct ids",
        ra === "aaa-111" && rb === "bbb-222",
        `a=${ra} b=${rb}`,
      );
    }

    // 4. a log line carries the id
    {
      const r = await get(port, "/rid-log", { "x-request-id": "corr-9f8e7d" });
      assert("log route echoes the id", r.headers["x-request-id"] === "corr-9f8e7d", String(r.headers["x-request-id"]));
      const logText = readFileSync(join(logDir, "tina4.log"), "utf8");
      const markerLines = logText.split("\n").filter((l) => l.includes("rid-log-marker"));
      assert("the handler log line was written to the file", markerLines.length > 0);
      // Format-agnostic (Decision 3): with TINA4_DEBUG unset (set just above)
      // this resolves to JSON by default, where the id appears as
      // "request_id":"corr-9f8e7d" rather than TEXT format's [corr-9f8e7d]
      // bracket. Accept either real rendering rather than pinning one format.
      assert(
        "the log line carries the request id",
        markerLines.some((l) => l.includes("[corr-9f8e7d]") || l.includes('"request_id":"corr-9f8e7d"')),
        markerLines.join(" | "),
      );
    }

    // Direct, no-dependency unit checks of the sanitizer (a pure function). The
    // tight mutation target for the CR/LF vector too, which a compliant HTTP
    // client cannot deliver over the wire.
    {
      const goods = ["abc123", "trace-id_9.8", "A".repeat(128), "0", "x.y-z_1"];
      assert("sanitizer honours well-formed ids", goods.every((g) => Log.sanitizeRequestId(g) === g));
    }
    {
      const bads: (string | undefined)[] = [
        "abc\r\nSet-Cookie: x=1", // CRLF header injection
        "abc\rinject",           // bare CR
        "abc\ninject",           // bare LF
        "has space",             // space not allowed
        "semi;colon",            // ; not allowed
        "curl|bash",             // pipe not allowed
        "<script>",              // angle brackets not allowed
        "a".repeat(129),         // over the length cap
        "",                      // empty
        undefined,               // absent
      ];
      assert(
        "sanitizer rejects hostile or malformed ids",
        bads.every((b) => Log.sanitizeRequestId(b as any) === undefined),
      );
    }
  } finally {
    server.close();
    try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    if (prev.debug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = prev.debug;
    if (prev.out === undefined) delete process.env.TINA4_LOG_OUTPUT; else process.env.TINA4_LOG_OUTPUT = prev.out;
    if (prev.rate === undefined) delete process.env.TINA4_RATE_LIMIT; else process.env.TINA4_RATE_LIMIT = prev.rate;
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
