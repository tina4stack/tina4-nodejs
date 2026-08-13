/**
 * Configurable error pages — Accept-based negotiation, converged 403, request-id, escaping.
 *
 * Feature 42. See ERR-DEC-01/ERR-DEC-02 and
 * tina4-documentation/plan/v3/fixtures/error_pages_contract.json.
 *
 * Driven through a REAL server (startServer) over a REAL socket - NO mocks.
 * Real Accept headers, a real GLOBAL class-based middleware denial for the
 * 403 case (the gap this feature closes - middleware.ts's interpretHookResult
 * used to set a BARE 403 status with no body at all), a real malicious path.
 *
 * Cases (shared names, all four):
 *   1. prod_500_has_no_stack_and_a_request_id  - the LOCKED CWE-209 guarantee
 *      (do not reopen; re-proven here as part of this feature's negotiated
 *      500 path).
 *   2. json_accept_yields_a_json_error_body    - Accept: application/json on
 *      404/403/500 -> {error,code,message,status,request_id}.
 *   3. browser_accept_yields_the_html_error_page - Accept: text/html or the
 *      wildcard media range -> the HTML errors/{code}.twig page.
 *   4. the_403_renders_identically_across_the_four - a middleware denial now
 *      renders through the SAME negotiated path as 404/500.
 *   5. a_custom_error_template_overrides_the_builtin - src/templates/errors/
 *      {code}.twig wins over the framework default, for 404 AND 500.
 *   6. a_reflected_path_in_an_error_page_is_escaped - a <script> path on
 *      404/403/500 never appears unescaped in the HTML body.
 *   7. the_404_carries_a_request_id - the negotiated JSON body carries
 *      request_id (Node did not have this before).
 *
 * Same case names in all four:
 *   tina4-python/tests/test_error_pages_contract.py
 *   tina4-php/tests/ErrorPagesContractTest.php
 *   tina4-ruby/spec/error_pages_contract_spec.rb
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { startServer, MiddlewareRunner } from "../packages/core/src/index.ts";
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

const SECRET_500_MARKER = "SECRET-500-TRACE-do-not-leak-e42a-node";
// Node's own URL parsing (the WHATWG path percent-encode set, applied by
// node:http itself - verified with a raw, unencoded socket write, not just
// http.request) neutralises '<'/'>' into %3C/%3E BEFORE the framework ever
// sees req.path - a real, verified platform-level defence the other three
// languages don't have. That also means a route PATTERN registered with a
// literal '<script>...' can never match a live request for it (the request
// arrives pre-encoded, the pattern doesn't) - Router.get() with such a
// pattern is unusable for a 403/500 fixture here, not a bug in this feature.
// So: the 404 case (needs no route match) proves BOTH properties with one
// path - a <script> tag AND a trailing apostrophe (which survives URL
// parsing unencoded); the 403/500 cases (need a route match) use an
// apostrophe-only payload to prove Frond's OWN {{ }} escaping specifically.
const MALICIOUS_PATH_404 = "/<script>tina4XssProbe</script>'";
const MALICIOUS_PATH_QUOTE = "/tina4-xss'probe";

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

async function main() {
  const base = mkdtempSync(join(tmpdir(), "tina4-errpages-"));
  mkdirSync(join(base, "src", "routes"), { recursive: true });
  mkdirSync(join(base, "public"), { recursive: true });

  const prevDebug = process.env.TINA4_DEBUG;
  delete process.env.TINA4_DEBUG;
  const prevRate = process.env.TINA4_RATE_LIMIT;
  process.env.TINA4_RATE_LIMIT = "100000";

  MiddlewareRunner.reset();

  const port = await freePort();
  const server = await startServer({
    port,
    basePath: base,
    routesDir: join(base, "src", "routes"),
    modelsDir: join(base, "src", "models"),
    staticDir: join(base, "public"),
  });

  server.router.get("/boom", async () => {
    throw new Error(SECRET_500_MARKER);
  });

  // A GLOBAL class-based middleware that denies without setting its own
  // response - one of the two gaps this feature closes. Registered on a
  // route reserved just for it so earlier cases (404/500) are unaffected.
  class DenyAllGlobal {
    static beforeDeny(_req: unknown, _res: unknown): boolean {
      return false;
    }
  }
  server.router.get("/blocked-global", async (_req: any, res: any) => res.json({ should: "never get here" }, 200));

  try {
    // ------------------------------------------------- 1. CWE-209, locked
    {
      const r = await req(port, "/boom");
      assert("prod_500_has_no_stack_and_a_request_id: status", r.status === 500, String(r.status));
      for (const marker of [SECRET_500_MARKER, "at ", ".ts:", "Error:"]) {
        assert(
          `prod_500_has_no_stack_and_a_request_id: no leak of ${JSON.stringify(marker)}`,
          !r.body.includes(marker),
          r.body.slice(0, 200),
        );
      }
      assert("prod_500_has_no_stack_and_a_request_id: has X-Request-ID", !!r.headers["x-request-id"]);

      const rJson = await req(port, "/boom", { Accept: "application/json" });
      assert("prod_500_has_no_stack_and_a_request_id (json): status", rJson.status === 500);
      const body = JSON.parse(rJson.body);
      assert(
        "prod_500_has_no_stack_and_a_request_id (json): no leak in body",
        !JSON.stringify(body).includes(SECRET_500_MARKER),
      );
      assert("prod_500_has_no_stack_and_a_request_id (json): generic message", body.message === "Internal Server Error");
      assert("prod_500_has_no_stack_and_a_request_id (json): has request_id", !!body.request_id);
      assert(
        "prod_500_has_no_stack_and_a_request_id (json): request_id matches header",
        body.request_id === rJson.headers["x-request-id"],
      );
    }

    // --------------------------------------------- 2 & 3. content negotiation (404, 500)
    for (const [code, path] of [[404, "/does-not-exist"], [500, "/boom"]] as [number, string][]) {
      const r = await req(port, path, { Accept: "application/json" });
      assert(`json_accept_yields_a_json_error_body (${code}): status`, r.status === code, String(r.status));
      assert(
        `json_accept_yields_a_json_error_body (${code}): content-type`,
        String(r.headers["content-type"]).includes("application/json"),
        String(r.headers["content-type"]),
      );
      const body = JSON.parse(r.body);
      assert(`json_accept_yields_a_json_error_body (${code}): error=true`, body.error === true);
      assert(`json_accept_yields_a_json_error_body (${code}): code`, typeof body.code === "string" && body.code.length > 0);
      assert(`json_accept_yields_a_json_error_body (${code}): message`, typeof body.message === "string" && body.message.length > 0);
      assert(`json_accept_yields_a_json_error_body (${code}): status field`, body.status === code);
      assert(`json_accept_yields_a_json_error_body (${code}): request_id`, !!body.request_id);
    }

    for (const [code, path, accept] of [
      [404, "/does-not-exist", "text/html"],
      [404, "/does-not-exist", "*/*"],
      [500, "/boom", "text/html"],
    ] as [number, string, string][]) {
      const r = await req(port, path, { Accept: accept });
      assert(`browser_accept_yields_the_html_error_page (${code} ${accept}): status`, r.status === code);
      assert(
        `browser_accept_yields_the_html_error_page (${code} ${accept}): content-type`,
        String(r.headers["content-type"]).includes("text/html"),
      );
      assert(
        `browser_accept_yields_the_html_error_page (${code} ${accept}): body`,
        r.body.includes(`"error-code">${code}<`),
      );
    }

    // ------------------------------------------------------------ 4. 403 split
    {
      MiddlewareRunner.use(DenyAllGlobal);

      const rJson = await req(port, "/blocked-global", { Accept: "application/json" });
      assert("the_403_renders_identically_across_the_four (json): status", rJson.status === 403, String(rJson.status));
      assert(
        "the_403_renders_identically_across_the_four (json): content-type",
        String(rJson.headers["content-type"]).includes("application/json"),
        String(rJson.headers["content-type"]),
      );
      const body = JSON.parse(rJson.body);
      assert(
        "the_403_renders_identically_across_the_four (json): body shape",
        body.error === true && body.code === "FORBIDDEN" && body.message === "Forbidden" && body.status === 403 && !!body.request_id,
        JSON.stringify(body),
      );

      const rHtml = await req(port, "/blocked-global", { Accept: "text/html" });
      assert("the_403_renders_identically_across_the_four (html): status", rHtml.status === 403);
      assert(
        "the_403_renders_identically_across_the_four (html): content-type",
        String(rHtml.headers["content-type"]).includes("text/html"),
        String(rHtml.headers["content-type"]),
      );
      assert(
        "the_403_renders_identically_across_the_four (html): body",
        rHtml.body.includes('"error-code">403<'),
      );

      // json_accept / browser_accept, but for 403 specifically (completes the
      // shared parametrised set the other three languages run).
      assert("json_accept_yields_a_json_error_body (403): status", rJson.status === 403);
      assert("browser_accept_yields_the_html_error_page (403 text/html): status", rHtml.status === 403);
    }

    // DenyAllGlobal is process-wide (MiddlewareRunner.use) - drop it now so
    // it doesn't also intercept the /boom-throwing route registered below.
    MiddlewareRunner.reset();

    // --------------------------------------------------- 6. reflected-path escaping
    {
      // 404 - no route match needed, so the FULL <script>...'  payload
      // reaches ctx.pathname unmolested by the route-matching step. Proves
      // both: no raw <script> tag (Node's own URL parsing already
      // percent-encodes '<'/'>' - a real, verified platform defence), and
      // Frond's OWN {{ }} escaping (the trailing apostrophe, which the URL
      // layer does NOT touch, comes back as &#x27;).
      const r = await req(port, MALICIOUS_PATH_404);
      assert("a_reflected_path_in_an_error_page_is_escaped (404): status", r.status === 404, String(r.status));
      assert(
        "a_reflected_path_in_an_error_page_is_escaped (404): no raw script",
        !r.body.includes("<script>tina4XssProbe</script>"),
        r.body.slice(0, 300),
      );
      assert(
        "a_reflected_path_in_an_error_page_is_escaped (404): escaped quote present",
        r.body.includes("&#x27;") || r.body.includes("&#39;"),
        r.body.slice(0, 300),
      );
    }

    {
      // 403 - a PER-ROUTE class middleware (not global) so this case needs no
      // ordering dance with the other tests' global middleware state.
      class DenyThisRoute {
        static beforeDeny(_req: unknown, _res: unknown): boolean {
          return false;
        }
      }
      const path403 = `${MALICIOUS_PATH_QUOTE}-403`;
      server.router.get(path403, async (_req: any, res: any) => res.json({ never: true }, 200), [DenyThisRoute]);
      const r = await req(port, path403);
      assert("a_reflected_path_in_an_error_page_is_escaped (403): status", r.status === 403, String(r.status));
      assert(
        "a_reflected_path_in_an_error_page_is_escaped (403): escaped quote present",
        r.body.includes("&#x27;") || r.body.includes("&#39;"),
        r.body.slice(0, 300),
      );
    }

    {
      // 500 - errors/500.twig does not show {{ path }} (only error_message/
      // request_id, and error_message is empty in prod per CWE-209), so there
      // is nothing to reflect there either way - this only re-confirms status.
      const path500 = `${MALICIOUS_PATH_QUOTE}-500`;
      server.router.get(path500, async () => {
        throw new Error(SECRET_500_MARKER);
      });
      const r = await req(port, path500);
      assert("a_reflected_path_in_an_error_page_is_escaped (500): status", r.status === 500, String(r.status));
    }

    // ------------------------------------------------------- 7. 404 request-id
    {
      const r = await req(port, "/does-not-exist", { Accept: "application/json" });
      const body = JSON.parse(r.body);
      assert("the_404_carries_a_request_id: present", !!body.request_id);
      assert(
        "the_404_carries_a_request_id: matches header",
        body.request_id === r.headers["x-request-id"],
        `body=${body.request_id} header=${r.headers["x-request-id"]}`,
      );
    }
  } finally {
    server.close();
    MiddlewareRunner.reset();
  }

  // ---------------------------------------------------- 5. override the built-in
  // A SEPARATE server instance whose basePath already carries a custom
  // src/templates/errors/{code}.twig BEFORE startServer() resolves
  // templatesDir, so it never contends with the default-template assertions
  // above.
  {
    const overrideBase = mkdtempSync(join(tmpdir(), "tina4-errpages-override-"));
    mkdirSync(join(overrideBase, "src", "routes"), { recursive: true });
    mkdirSync(join(overrideBase, "src", "templates", "errors"), { recursive: true });
    mkdirSync(join(overrideBase, "public"), { recursive: true });
    writeFileSync(join(overrideBase, "src", "templates", "errors", "404.twig"), "CUSTOM-404-NODE path={{ path }}");
    writeFileSync(join(overrideBase, "src", "templates", "errors", "500.twig"), "CUSTOM-500-NODE rid={{ request_id }}");

    const overridePort = await freePort();
    const overrideServer = await startServer({
      port: overridePort,
      basePath: overrideBase,
      routesDir: join(overrideBase, "src", "routes"),
      modelsDir: join(overrideBase, "src", "models"),
      staticDir: join(overrideBase, "public"),
      templatesDir: join(overrideBase, "src", "templates"),
    });
    overrideServer.router.get("/boom", async () => {
      throw new Error(SECRET_500_MARKER);
    });

    try {
      const r404 = await req(overridePort, "/nope");
      assert("a_custom_error_template_overrides_the_builtin (404): status", r404.status === 404);
      assert("a_custom_error_template_overrides_the_builtin (404): body", r404.body.includes("CUSTOM-404-NODE"), r404.body);

      const r500 = await req(overridePort, "/boom");
      assert("a_custom_error_template_overrides_the_builtin (500): status", r500.status === 500);
      assert("a_custom_error_template_overrides_the_builtin (500): body", r500.body.includes("CUSTOM-500-NODE"), r500.body);
    } finally {
      overrideServer.close();
      try { rmSync(overrideBase, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  if (prevDebug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = prevDebug;
  if (prevRate === undefined) delete process.env.TINA4_RATE_LIMIT; else process.env.TINA4_RATE_LIMIT = prevRate;

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
