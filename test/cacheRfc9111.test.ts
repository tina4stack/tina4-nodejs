/**
 * RFC 9111 conformance for the SHARED response cache.
 *
 * The cache key is method + URL only, with no header input. On Node the
 * responseCache middleware runs BEFORE the auth gate, so an anonymous caller
 * was served an authenticated caller's body with a 200 — an authentication
 * bypass, not merely a stale-data bug. Two normative rules stop that:
 *
 *   s3   — "if the cache is shared: the Authorization header field is not
 *          present in the request ... or a response directive is present that
 *          explicitly allows shared caching"
 *   s4.1 — "the cache MUST NOT use that stored response without revalidation
 *          unless all the presented request header fields nominated by that
 *          Vary field value match those fields in the original request"
 *
 * Test names match tina4-python, tina4-php and tina4-ruby one-for-one.
 * Run with: npx tsx test/cacheRfc9111.test.ts
 */
import { responseCache, clearCache, createBackend, _resetBackend } from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";

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

/** A response double over the REAL middleware contract: res(body, status, ct). */
function makeRes(outHeaders: Record<string, string>, presetHeaders: Record<string, string> = {}) {
  const res: any = function (body: string, statusCode = 200, contentType?: string) {
    res._served = { body, statusCode, contentType };
    return res;
  };
  res._served = null;
  res.raw = {
    writableEnded: false,
    statusCode: 200,
    end(_c: any) { return this; },
    getHeader: (n: string) => presetHeaders[n] ?? presetHeaders[n.toLowerCase()]
      ?? outHeaders[n.toLowerCase()] ?? (n.toLowerCase() === "content-type" ? "application/json" : undefined),
  };
  res.header = (n: string, v: string) => { outHeaders[n.toLowerCase()] = v; };
  return res;
}

/**
 * Drive one request through the middleware. Returns what the caller received
 * and whether the handler ran (a HIT never calls next()).
 */
async function roundTrip(
  mw: any,
  url: string,
  opts: { headers?: Record<string, string>; body?: string; responseHeaders?: Record<string, string> } = {},
) {
  const outHeaders: Record<string, string> = {};
  const res = makeRes(outHeaders, opts.responseHeaders ?? {});
  const req = { method: "GET", url, headers: opts.headers ?? {} } as unknown as Tina4Request;
  let handlerRan = false;
  await mw(req, res, () => { handlerRan = true; });
  if (handlerRan) {
    res.raw.end(opts.body ?? "");
    // backend.set is fire-and-forget inside end(); let the microtask land.
    await new Promise((r) => setTimeout(r, 30));
  }
  return {
    body: handlerRan ? (opts.body ?? "") : (res._served?.body ?? null),
    handlerRan,
    headers: outHeaders,
  };
}

async function main() {
  console.log("=== Response Cache RFC 9111 Conformance ===\n");

  delete process.env.TINA4_CACHE_BACKEND;

  // --- s3 / s3.5: responses to authorized requests -----------------------
  {
    _resetBackend();
    await clearCache();
    const mw = responseCache({ ttl: 60 });

    await roundTrip(mw, "/api/me", {
      headers: { authorization: "Bearer alice" },
      body: '{"secret_for":"alice"}',
    });

    const bob = await roundTrip(mw, "/api/me", {
      headers: { authorization: "Bearer bob" },
      body: '{"secret_for":"bob"}',
    });
    const anon = await roundTrip(mw, "/api/me", { body: '{"secret_for":"anon"}' });

    assert("response_cache_does_not_store_a_response_to_an_authorized_request",
      !bob.body.includes("alice") && !anon.body.includes("alice"),
      `bob=${bob.body} anon=${anon.body}`);
    assert("response_cache_does_not_store_a_response_to_an_authorized_request (handler must run)",
      bob.handlerRan && anon.handlerRan);
  }

  {
    _resetBackend();
    await clearCache();
    const mw = responseCache({ ttl: 60 });

    await roundTrip(mw, "/api/rates", {
      headers: { authorization: "Bearer any" },
      body: '{"usd":"shared-rates"}',
      responseHeaders: { "Cache-Control": "public, max-age=60" },
    });
    const second = await roundTrip(mw, "/api/rates", {
      headers: { authorization: "Bearer other" },
      body: '{"usd":"recomputed"}',
    });

    assert("response_cache_stores_an_authorized_response_when_cache_control_public",
      !second.handlerRan && String(second.body).includes("shared-rates"),
      `handlerRan=${second.handlerRan} body=${second.body}`);
  }

  {
    // Negative control: the fix must not simply disable caching everywhere.
    _resetBackend();
    await clearCache();
    const mw = responseCache({ ttl: 60 });

    await roundTrip(mw, "/api/public", { body: '{"v":"public-body"}' });
    const second = await roundTrip(mw, "/api/public", { body: '{"v":"recomputed"}' });

    assert("response_cache_serves_an_unauthenticated_get",
      !second.handlerRan && String(second.body).includes("public-body"),
      `handlerRan=${second.handlerRan} body=${second.body}`);
    assert("response_cache_serves_an_unauthenticated_get (X-Cache: HIT)",
      second.headers["x-cache"] === "HIT", JSON.stringify(second.headers));
  }

  // --- s4.1: Vary ---------------------------------------------------------
  {
    _resetBackend();
    await clearCache();
    const mw = responseCache({ ttl: 60 });
    const varyHeader = { Vary: "Accept-Language" };

    await roundTrip(mw, "/api/greeting", {
      headers: { "accept-language": "en" }, body: '"english"', responseHeaders: varyHeader,
    });

    const same = await roundTrip(mw, "/api/greeting", {
      headers: { "accept-language": "en" }, body: '"recomputed"', responseHeaders: varyHeader,
    });
    const fr = await roundTrip(mw, "/api/greeting", {
      headers: { "accept-language": "fr" }, body: '"french"', responseHeaders: varyHeader,
    });
    const none = await roundTrip(mw, "/api/greeting", {
      body: '"default"', responseHeaders: varyHeader,
    });

    assert("response_cache_honours_vary_on_a_nominated_request_header",
      !same.handlerRan && fr.handlerRan && none.handlerRan,
      `same=${same.handlerRan} fr=${fr.handlerRan} none=${none.handlerRan}`);
    assert("response_cache_honours_vary_on_a_nominated_request_header (matching variant hits)",
      String(same.body).includes("english"), String(same.body));
  }

  {
    _resetBackend();
    await clearCache();
    const mw = responseCache({ ttl: 60 });

    await roundTrip(mw, "/api/anything", {
      body: '"never-reusable"', responseHeaders: { Vary: "*" },
    });
    const second = await roundTrip(mw, "/api/anything", { body: '"recomputed"' });

    assert("response_cache_never_stores_vary_asterisk",
      second.handlerRan, `handlerRan=${second.handlerRan} body=${second.body}`);
  }

  // --- backend name validation -------------------------------------------
  {
    let threw = "";
    try {
      await createBackend({ backend: "redsi" });
    } catch (e: any) {
      threw = String(e?.message ?? "");
    }
    assert("cache_backend_unknown_name_raises",
      threw.includes("redsi") && threw.includes("memory, file, redis, valkey, memcached, mongodb, database"),
      threw || "(did not throw)");

    const names = ["memory", "MEMORY", " memory ", ""];
    let allBuilt = true;
    for (const name of names) {
      const be = await createBackend({ backend: name });
      if (be.name() !== "memory") allBuilt = false;
    }
    assert("cache_backend_known_names_do_not_raise", allBuilt);
  }

  _resetBackend();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test harness error:", e);
  process.exit(1);
});
