/**
 * Locks in downloadSkillsSync()'s retry pass (packages/core/src/ai.ts) —
 * mirrors tina4-python's tests/test_ai_fetch_retry.py and the equivalent
 * PHP/Ruby specs. `installSkills()` fetches ~30 files from
 * raw.githubusercontent.com per install, which 503s intermittently under
 * load (a freshly cut release tag is "cold" on GitHub's CDN until it warms)
 * — a single transient blip must not abort the whole install.
 *
 * NO MOCKS: a REAL HTTP server (test/fixtures/aiFetchRetryServer.mjs)
 * answers a scripted sequence over a real socket. It runs as a SEPARATE OS
 * PROCESS — not an in-process http.createServer() like test/api.test.ts uses
 * — because downloadSkillsSync() fetches through a BLOCKING
 * child.execFileSync() call that freezes this test process's own event loop
 * until the child node exits. A same-process server sharing that event loop
 * could never accept the child's connection; see the fixture's header
 * comment for the full explanation. Attempt counts are read back with a REAL
 * follow-up HTTP GET to the server's own /hits endpoint (once
 * downloadSkillsSync has returned and this process's event loop is free
 * again) rather than by scraping subprocess stdout, which raced with the
 * server process's own (async, non-TTY) stdout flush.
 *
 * downloadSkillsSync is normally module-private; it is exported (like
 * writeOrMerge/markersFor/skillBlock in the same file) purely so this test
 * can drive it directly — a pure visibility change, no behaviour change.
 *
 * Node's retry shape is NOT identical to Python/PHP/Ruby's, and that is
 * measured here rather than assumed:
 *   - Exactly ONE retry pass (2 total attempts), no backoff sleep at all
 *     (see the `for (let attempt = 0; attempt < 2 ...)` loop in ai.ts) — so
 *     a "503, 503, 200" script (which Python/PHP/Ruby's 3-5 attempt budgets
 *     ride through) would exhaust Node's 2-attempt budget and never reach
 *     the 200. The positive case below uses "503, 200" instead — the
 *     sequence Node's real budget can recover from.
 *   - The retry pass is status-aware: transport failures and transient HTTP
 *     statuses retry, while a permanent 4xx is accepted as a final answer.
 *     This matches Python/PHP/Ruby and avoids a request that cannot succeed.
 *
 * Run with: npx tsx test/aiFetchRetry.test.ts
 */
import { downloadSkillsSync } from "../packages/core/src/ai.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** Spawn the real scripted server as a separate process; resolve once it reports READY. */
function startServer(): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, "fixtures", "aiFetchRetryServer.mjs"), "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffered = "";
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error("aiFetchRetryServer.mjs never printed READY within 5s"));
      }
    }, 5000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf-8");
      const idx = buffered.indexOf("\n");
      if (idx !== -1 && !resolved) {
        const line = buffered.slice(0, idx).trim();
        if (line.startsWith("READY ")) {
          resolved = true;
          clearTimeout(timer);
          resolve({ port: Number(line.slice("READY ".length)), stop: () => child.kill() });
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

/** How many requests the REAL server saw for a path — a live HTTP read, not an in-process counter. */
async function hits(base: string, path: string): Promise<number> {
  const r = await fetch(`${base}/hits?path=${encodeURIComponent(path)}`);
  const body = (await r.json()) as { hits: number };
  return body.hits;
}

console.log("=== AI fetch retry (real local server, separate process, no mocks) ===\n");

const tmp = mkdtempSync(join(tmpdir(), "tina4-ai-fetch-retry-"));

async function run() {
  const srv = await startServer();
  const base = `http://127.0.0.1:${srv.port}`;

  try {
    // ── POSITIVE: one transient 503, then a 200 — downloadSkillsSync must
    // ride through the retry pass and write the real body to disk. ────────
    const skillDest = join(tmp, "skill", "SKILL.md");
    const okUrls = downloadSkillsSync([{ url: `${base}/skill`, dests: [skillDest] }]);

    assert("POSITIVE: /skill URL reported as fetched", okUrls.has(`${base}/skill`), `got: ${[...okUrls]}`);
    assert("POSITIVE: SKILL.md file was written", existsSync(skillDest));
    if (existsSync(skillDest)) {
      const body = readFileSync(skillDest, "utf-8");
      assert("POSITIVE: file holds the REAL post-retry body", body === "skill body", `got: ${JSON.stringify(body)}`);
    }
    const skillHits = await hits(base, "/skill");
    assert(
      "POSITIVE: server saw exactly 2 hits — proves it actually retried once, not zero",
      skillHits === 2,
      `got: ${skillHits}`,
    );

    // ── NEGATIVE: a persistent 404 is a final answer, not a transient
    // failure. It must not be retried or write a destination file. ─────────
    const missingDest = join(tmp, "missing", "SKILL.md");
    const start = Date.now();
    const okUrls2 = downloadSkillsSync([{ url: `${base}/missing`, dests: [missingDest] }]);
    const elapsedMs = Date.now() - start;

    assert("NEGATIVE: /missing URL is never reported as fetched", !okUrls2.has(`${base}/missing`));
    assert("NEGATIVE: no file was written for a 404", !existsSync(missingDest));
    assert(
      "NEGATIVE: completes fast — permanent 4xx has no retry/backoff",
      elapsedMs < 2000,
      `took ${elapsedMs}ms`,
    );
    const missingHits = await hits(base, "/missing");
    assert(
      "NEGATIVE: a persistent 404 is requested exactly once",
      missingHits === 1,
      `got: ${missingHits}`,
    );
  } finally {
    srv.stop();
  }
}

try {
  await run();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
