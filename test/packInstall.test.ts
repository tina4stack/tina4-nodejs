/**
 * Pack-install regression test for issue #32 — a REAL consumer install (NO mocks).
 *
 * The published `tina4-nodejs` package is the ONLY package on npm (its
 * `dependencies` is empty) and it ships raw `.ts` sources. Before 3.13.70 the
 * internal cross-package imports used the bare workspace specifier
 * `@tina4/{core,orm,frond,swagger}`, which only resolves in the monorepo via
 * `node_modules/@tina4/*` symlinks. A consumer install has no such symlinks, so
 * `import ... from "tina4-nodejs/orm"` threw ERR_MODULE_NOT_FOUND (#32).
 *
 * This test reproduces a genuine consumer:
 *   1. `npm pack` the repo into a temp dir -> the real tarball CI would publish.
 *   2. `npm install <tarball>` into a throwaway project OUTSIDE the monorepo, so
 *      there is NO @tina4/* symlink to lean on (a true consumer environment).
 *   3. Run a consumer script UNDER tsx (exactly how a scaffolded tina4-nodejs app
 *      runs) that imports all four published entrypoints, asserts the ORM surface
 *      (`getCollection` / `initDatabase`) loads, and drives `getFrond()` — the
 *      same lazy path `response.render()` uses — to prove the dynamic frond import
 *      resolves in a consumer.
 *
 * A green run here is the check that would have caught #32.
 * Run with: npx tsx test/packInstall.test.ts
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

// Consumer script source. Deliberately backtick-free so it can live inside this
// parent template literal without escaping. It imports the PUBLISHED specifiers
// (tina4-nodejs, tina4-nodejs/orm, tina4-nodejs/frond, tina4-nodejs/swagger) —
// never a relative path into the package internals.
const CONSUMER_SRC = `
import { getToken, getFrond } from "tina4-nodejs";
import { getCollection, initDatabase } from "tina4-nodejs/orm";
import { Frond } from "tina4-nodejs/frond";
import { generate } from "tina4-nodejs/swagger";

const checks: Array<[string, boolean]> = [];
checks.push(["import tina4-nodejs (core) -> getToken is fn", typeof getToken === "function"]);
checks.push(["import tina4-nodejs/orm -> getCollection is fn", typeof getCollection === "function"]);
checks.push(["import tina4-nodejs/orm -> initDatabase is fn", typeof initDatabase === "function"]);
checks.push(["import tina4-nodejs/frond -> Frond is fn", typeof Frond === "function"]);
checks.push(["import tina4-nodejs/swagger -> generate is fn", typeof generate === "function"]);

// Drive the dynamic frond import that lives inside response.ts (the exact code
// path response.render() takes): getFrond() lazily loads the Frond engine.
const frond = await getFrond();
const rendered = frond.renderString("Hello {{ who }}!", { who: "consumer" });
checks.push(["response getFrond() dynamic frond import + render", rendered === "Hello consumer!"]);

let ok = true;
for (const entry of checks) {
  const label = entry[0];
  const pass = entry[1];
  console.log((pass ? "PASS " : "FAIL ") + label);
  if (!pass) ok = false;
}
console.log(ok ? "CONSUMER_OK" : "CONSUMER_FAIL");
process.exit(ok ? 0 : 1);
`;

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? " — " + detail : ""}`);
  }
}

console.log("\n=== Pack-Install Regression (#32) — real npm pack + install, no mocks ===\n");

const workDir = mkdtempSync(join(tmpdir(), "tina4-pack-"));
try {
  // 1) Build the real tarball CI would publish.
  let tarball = "";
  try {
    execFileSync("npm", ["pack", "--pack-destination", workDir], {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const tgz = readdirSync(workDir).find((f) => f.endsWith(".tgz")) || "";
    tarball = tgz ? join(workDir, tgz) : "";
    assert("npm pack produced a tarball", !!tarball && existsSync(tarball), tarball || "no .tgz emitted");
  } catch (err) {
    assert("npm pack produced a tarball", false, (err as Error).message);
  }

  if (tarball) {
    // 2) Throwaway consumer project OUTSIDE the monorepo (no @tina4/* symlinks).
    const appDir = join(workDir, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "package.json"),
      JSON.stringify(
        { name: "tina4-consumer-test", version: "0.0.0", private: true, type: "module" },
        null,
        2,
      ),
    );

    // 3) Install the tarball. Optional drivers are not needed to prove import
    //    resolution (they are lazily required only when their feature is used),
    //    so --no-optional keeps the install fast and network-free.
    let installed = false;
    try {
      execFileSync(
        "npm",
        [
          "install", tarball,
          "--no-audit", "--no-fund", "--ignore-scripts", "--no-optional", "--prefer-offline",
        ],
        { cwd: appDir, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      installed = existsSync(join(appDir, "node_modules", "tina4-nodejs"));
      assert("npm install <tarball> into throwaway app", installed);
    } catch (err) {
      assert("npm install <tarball> into throwaway app", false, (err as Error).message);
    }

    // 4) Prove this is a genuine consumer env: there is NO @tina4/* on disk, so
    //    every internal import MUST have resolved via the relative-path fix.
    assert(
      "consumer node_modules has NO @tina4/* (relative imports only)",
      !existsSync(join(appDir, "node_modules", "@tina4")),
    );

    if (installed) {
      // 5) Run the consumer under the monorepo's tsx (how a real tina4-nodejs app
      //    runs). Resolution of bare `tina4-nodejs` walks up from the script dir,
      //    landing in the throwaway's node_modules — never the monorepo.
      const consumer = join(appDir, "consumer.ts");
      writeFileSync(consumer, CONSUMER_SRC);
      const tsxBin = join(rootDir, "node_modules", ".bin", "tsx");
      assert("monorepo tsx runner is available", existsSync(tsxBin), tsxBin);

      let stdout = "";
      let ran = false;
      try {
        stdout = execFileSync(tsxBin, [consumer], {
          cwd: appDir,
          encoding: "utf-8",
          timeout: 60_000,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        ran = true;
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        stdout = (e.stdout || "") + (e.stderr || "") + (e.message || "");
      }

      // Surface the consumer's own output for a legible failure.
      for (const line of stdout.split("\n")) {
        if (line.trim()) console.log(`    [consumer] ${line}`);
      }

      assert("consumer script ran to completion (exit 0)", ran, "child process exited non-zero");
      assert(
        "consumer: import tina4-nodejs (core) resolves",
        stdout.includes("PASS import tina4-nodejs (core)"),
      );
      assert(
        "consumer: import tina4-nodejs/orm resolves (issue #32)",
        stdout.includes("PASS import tina4-nodejs/orm -> getCollection") &&
          stdout.includes("PASS import tina4-nodejs/orm -> initDatabase"),
      );
      assert(
        "consumer: import tina4-nodejs/frond resolves",
        stdout.includes("PASS import tina4-nodejs/frond"),
      );
      assert(
        "consumer: import tina4-nodejs/swagger resolves",
        stdout.includes("PASS import tina4-nodejs/swagger"),
      );
      assert(
        "consumer: dynamic frond import via getFrond() + real render",
        stdout.includes("PASS response getFrond()"),
      );
      assert("consumer overall CONSUMER_OK", stdout.includes("CONSUMER_OK"));
    }
  }
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

console.log(
  `\n  Pack-Install Test Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`,
);
process.exit(failed > 0 ? 1 : 0);
