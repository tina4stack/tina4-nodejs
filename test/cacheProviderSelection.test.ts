/**
 * CACHE CONTRACT - an explicit provider is honoured, and an unreachable one
 * degrades visibly.
 *
 * Pins TWO invariants from plan/v3/fixtures/cache_contract.json (ADR-0024),
 * because they are the two halves of one question: which provider did I
 * actually get, and was I told?
 *
 *     an-explicit-provider-is-honoured
 *         A provider requested explicitly is the provider used. It may not be
 *         overridden by ambient state such as another middleware instance
 *         already existing.
 *
 *     an-unreachable-backend-degrades-visibly
 *         A backend whose driver is missing or whose service is unreachable
 *         logs a warning and falls back to a REAL persistent cache (the file
 *         backend), never to a silent no-op.
 *
 * THE MEASURED DEFECT (Node)
 *     _getResponseBackend(config) opened with
 *         if (_responseBackend) return Promise.resolve(_responseBackend);
 *     so the memoised backend was returned BEFORE config was even read. Once
 *     any responseCache middleware existed, every later explicitly-requested
 *     provider was silently ignored. The developer names a backend, the
 *     framework quietly uses a different one, and the only symptom is cache
 *     behaviour that does not match the configuration.
 *
 * UNREACHABILITY IS REAL HERE. The tests point a backend at a genuinely closed
 * port on 127.0.0.1 - bound, read, released, so a connect() to it really fails
 * at the OS level - never a simulated outage. The warning assertion captures
 * the REAL console.warn the real code path emits; capturing output is
 * observation, not a stand-in for a dependency.
 *
 * Run with: npx tsx test/cacheProviderSelection.test.ts
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createBackend, _getResponseBackend, _resetBackend } from "../packages/core/src/cache.ts";
import { REDIS_URL } from "./_cacheProviders.ts";
import { requireServices } from "./_serviceGate.ts";

let pass = 0;
let fail = 0;
let skipped = 0;
let cases = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} (${reason})`);
  skipped++;
}

const RUN_ID = `${process.pid}_${Date.now()}`;
let dirCounter = 0;
/** A fresh cache directory per use, so no case can inherit another's files. */
function freshDir(label: string): string {
  const dir = path.join(os.tmpdir(), `tina4_provider_${RUN_ID}_${label}_${dirCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A port nothing is listening on. Bind it, read it, release it: the bind proves
 * it was free at that instant and the release means a connect() to it really
 * fails. A genuine unreachable service, not a stand-in for one.
 */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function reachable(url: string, defaultPort: number): Promise<boolean> {
  const cleaned = url.replace(/^[a-z+]+:\/\//, "").split("/")[0].split(":");
  const host = cleaned[0] || "127.0.0.1";
  const port = cleaned[1] ? parseInt(cleaned[1], 10) || defaultPort : defaultPort;
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 2000);
    if (timer.unref) timer.unref();
  });
}

/** Run `fn` with TINA4_CACHE_* pinned, restoring the previous environment after. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

// -- an explicit provider is honoured --------------------------------

async function anExplicitlyNamedProviderIsUsed(): Promise<void> {
  cases++;
  // Named "an explicitly named provider is used" rather than "an explicit
  // provider is honoured" ON PURPOSE: the contract auditor matches a case name
  // as a SUBSTRING of the suite file, so a name that is a PREFIX of another
  // case would still be "found" after it had been deleted. Do not shorten it.
  await withEnv({ TINA4_CACHE_BACKEND: "memory", TINA4_CACHE_DIR: freshDir("explicit") }, async () => {
    _resetBackend();
    // Build one first, so a memoised module-level backend already exists.
    const ambient = await _getResponseBackend();
    const explicit = await _getResponseBackend({ backend: "file", cacheDir: freshDir("explicit-file") });

    assert(
      "an explicitly named provider is used",
      explicit.name() === "file",
      `asked for the 'file' provider and got '${explicit.name()}' - the explicit request was overridden by ambient state`,
    );
    assert(
      "an explicitly named provider is used: the ambient provider is unchanged",
      ambient.name() === "memory",
      `building an explicit instance changed the ambient one to '${ambient.name()}'`,
    );
  });
}

async function anExplicitProviderIsHonouredAfterAnotherInstanceExists(): Promise<void> {
  cases++;
  // The measured Node defect, stated directly. ORDER MATTERS: this is exactly
  // the sequence that broke - some middleware is constructed, THEN a second one
  // names a provider and is silently ignored.
  await withEnv({ TINA4_CACHE_BACKEND: "memory", TINA4_CACHE_DIR: freshDir("second") }, async () => {
    _resetBackend();
    const first = await _getResponseBackend();
    assert(
      "an explicit provider is honoured after another instance exists: precondition, the ambient provider is memory",
      first.name() === "memory",
      `ambient provider was '${first.name()}'`,
    );

    const second = await _getResponseBackend({ backend: "file", cacheDir: freshDir("second-file") });

    assert(
      "an explicit provider is honoured after another instance exists",
      second.name() === "file",
      "the second middleware asked for 'file' and was handed the first instance's memoised backend instead",
    );
  });
}

async function twoExplicitProvidersDoNotShareABackend(): Promise<void> {
  cases++;
  // NEGATIVE: honouring the request must mean a DIFFERENT STORE, not a label.
  // A fix that records the requested name but still hands back the memoised
  // object would pass a name assertion and change nothing observable.
  await withEnv({ TINA4_CACHE_BACKEND: "memory", TINA4_CACHE_DIR: freshDir("shared") }, async () => {
    _resetBackend();
    const memoryCache = await _getResponseBackend({ backend: "memory" });
    const fileCache = await _getResponseBackend({ backend: "file", cacheDir: freshDir("shared-file") });

    await memoryCache.set("only-in-memory", { v: 1 }, 300);
    const leaked = await fileCache.get("only-in-memory");

    assert(
      "two explicit providers do not share a backend",
      leaked === undefined,
      `the two explicitly-named providers are the same object - the provider name was honoured but the store was not (got ${JSON.stringify(leaked)})`,
    );
  });
}

async function anUnrecognisedProviderRaises(): Promise<void> {
  cases++;
  // NEGATIVE: a typo must fail loudly, not fall through to memory. Falling
  // through turned TINA4_CACHE_BACKEND=redsi into a running app with a
  // per-process cache while the operator believed it was in Redis.
  let message = "";
  let threw = false;
  try {
    await createBackend({ backend: "redsi" });
  } catch (err) {
    threw = true;
    message = (err as Error).message;
  }
  assert(
    "an unrecognised provider raises",
    threw && message.includes("redsi") && message.includes("redis"),
    threw
      ? `the error does not name the bad value and list the valid backends: ${message}`
      : "createBackend('redsi') did not throw - a typo silently became a per-process cache",
  );
}

// -- an unreachable backend degrades visibly -------------------------

async function anUnreachableBackendFallsBackToTheFileBackend(): Promise<void> {
  cases++;
  const port = await closedPort();
  const dir = freshDir("fallback");
  await withEnv({ TINA4_CACHE_DIR: dir }, async () => {
    const wrong: string[] = [];
    for (const [backend, url] of [
      ["redis", `redis://127.0.0.1:${port}`],
      ["valkey", `valkey://127.0.0.1:${port}`],
      ["memcached", `memcached://127.0.0.1:${port}`],
      ["mongodb", `mongodb://127.0.0.1:${port}/tina4_cache_contract`],
    ] as Array<[string, string]>) {
      const resolved = await createBackend({ backend, cacheUrl: url, cacheDir: dir });
      // The fallback must be FILE - a real persistent cache. Never memory
      // (which silently loses cross-process sharing) and never a no-op.
      if (resolved.name() !== "file") wrong.push(`${backend} -> ${resolved.name()}`);
    }
    assert(
      "an unreachable backend falls back to the file backend",
      wrong.length === 0,
      `these did not fall back to 'file': ${wrong.join(", ")}`,
    );
  });
}

async function theFallbackBackendActuallyCaches(): Promise<void> {
  cases++;
  // Falling back is only useful if the replacement really caches. A fallback to
  // a no-op looks identical to a working cache until the load arrives.
  const port = await closedPort();
  const dir = freshDir("fallback-caches");
  await withEnv({ TINA4_CACHE_DIR: dir }, async () => {
    const resolved = await createBackend({ backend: "redis", cacheUrl: `redis://127.0.0.1:${port}`, cacheDir: dir });
    await resolved.set("fallback-key", { v: "cached" }, 300);
    const readBack = await resolved.get("fallback-key");
    const filesOnDisk = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;

    assert(
      "the fallback backend actually caches",
      JSON.stringify(readBack) === JSON.stringify({ v: "cached" }) && filesOnDisk > 0,
      `read back ${JSON.stringify(readBack)}, ${filesOnDisk} file(s) on disk in ${dir}`,
    );
  });
}

async function anUnreachableBackendLogsAWarning(): Promise<void> {
  cases++;
  // Capturing the REAL console.warn the REAL code path emits against a REAL
  // closed port. Observation of output, not a stand-in for a dependency.
  const port = await closedPort();
  const dir = freshDir("warn");
  const captured: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  try {
    await withEnv({ TINA4_CACHE_DIR: dir }, async () => {
      await createBackend({ backend: "redis", cacheUrl: `redis://127.0.0.1:${port}`, cacheDir: dir });
    });
  } finally {
    console.warn = originalWarn;
  }
  const warning = captured.join("\n");
  assert(
    "an unreachable backend logs a warning",
    captured.length > 0 && warning.includes("redis") && /fall(ing|s)? back|unavailable/i.test(warning),
    captured.length === 0
      ? "the cache degraded to the file backend SILENTLY - no warning was emitted"
      : `the warning does not name the backend and the degradation: ${warning}`,
  );
}

async function aReachableBackendIsNotReplaced(): Promise<void> {
  cases++;
  // NEGATIVE: the fallback must trigger ONLY on a real failure. A fallback that
  // fires on a healthy service would quietly demote every deployment to disk.
  const gate = requireServices();
  const up = await reachable(REDIS_URL, 6379);
  if (!up) {
    if (gate) {
      assert("a reachable backend is not replaced", false, "redis not reachable and TINA4_REQUIRE_SERVICES is set");
    } else {
      skip("a reachable backend is not replaced", "redis not reachable");
    }
    return;
  }
  const dir = freshDir("reachable");
  await withEnv({ TINA4_CACHE_DIR: dir }, async () => {
    const resolved = await createBackend({ backend: "redis", cacheUrl: REDIS_URL, cacheDir: dir });
    assert(
      "a reachable backend is not replaced",
      resolved.name() === "redis",
      `a healthy redis was replaced by '${resolved.name()}' - the fallback fires on a working service`,
    );
  });
}

async function main(): Promise<void> {
  console.log("\nCACHE CONTRACT: an-explicit-provider-is-honoured + an-unreachable-backend-degrades-visibly (ADR-0024)");

  const suite: Array<[string, () => Promise<void>]> = [
    ["an explicitly named provider is used", anExplicitlyNamedProviderIsUsed],
    ["an explicit provider is honoured after another instance exists", anExplicitProviderIsHonouredAfterAnotherInstanceExists],
    ["two explicit providers do not share a backend", twoExplicitProvidersDoNotShareABackend],
    ["an unrecognised provider raises", anUnrecognisedProviderRaises],
    ["an unreachable backend falls back to the file backend", anUnreachableBackendFallsBackToTheFileBackend],
    ["the fallback backend actually caches", theFallbackBackendActuallyCaches],
    ["an unreachable backend logs a warning", anUnreachableBackendLogsAWarning],
    ["a reachable backend is not replaced", aReachableBackendIsNotReplaced],
  ];

  for (const [name, run] of suite) {
    try {
      await run();
    } catch (err) {
      assert(name, false, `threw: ${(err as Error).message}`);
    }
  }
  _resetBackend();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Cases executed: ${cases}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skipped} skipped\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Test harness error:", err);
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(1);
});
