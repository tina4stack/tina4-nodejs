/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Production cluster mode hands requests to workers round-robin on every OS.
 *
 * Node's cluster module defaults to round-robin (SCHED_RR) everywhere except
 * Windows, where it defaults to SCHED_NONE: the OS picks the worker, and under
 * load it may keep picking the same one, so a "4-worker" server serves from
 * one. Tina4 now sets SCHED_RR before the first fork. An operator who sets
 * NODE_CLUSTER_SCHED_POLICY explicitly still gets their choice.
 *
 * Node freezes the policy at the first fork, so the primary reports it AFTER
 * startServer() has forked its workers: the value read is the one in force.
 * Real cluster, real workers, nothing simulated. The negative case (an explicit
 * `none` is respected) fails on Linux too if the framework ever forces RR.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cluster from "node:cluster";
import { randomBytes } from "node:crypto";
import { TSX_CLI, moduleUrl, killProcessTree } from "./_portableSpawn.ts";
import { removeTempDir } from "./_tempDir.ts";

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

const REPO = resolve(import.meta.dirname, "..");

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

/** Boot a production cluster in a child; resolve with the primary's policy. */
async function primaryPolicy(policyEnv: string | undefined): Promise<number | null> {
  const root = mkdtempSync(join(tmpdir(), "tina4-sched-"));
  const routes = join(root, "src", "routes");
  mkdirSync(routes, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"sched-probe","type":"module","private":true}\n');
  writeFileSync(join(root, "app.ts"),
    "import cluster from \"node:cluster\";\n" +
    `import { startServer } from ${JSON.stringify(moduleUrl(join(REPO, "packages/core/src/index.ts")))};\n` +
    `const srv: any = await startServer({ port: ${await freePort()}, host: "127.0.0.1", ` +
    `routesDir: ${JSON.stringify(routes)} } as never);\n` +
    "if (cluster.isPrimary) {\n" +
    "  console.log(`TINA4_SCHED_POLICY=${cluster.schedulingPolicy}`);\n" +
    "  srv.close();\n" +
    "  setTimeout(() => process.exit(0), 300);\n" +
    "}\n");

  const env: Record<string, string> = { ...process.env as Record<string, string>, TINA4_PRODUCTION: "true" };
  // Production boot refuses a missing or short signing secret; give it a real one.
  env.TINA4_SECRET = randomBytes(32).toString("hex");
  delete env.NODE_CLUSTER_SCHED_POLICY;
  if (policyEnv !== undefined) env.NODE_CLUSTER_SCHED_POLICY = policyEnv;

  const child = spawn(process.execPath, [TSX_CLI, "app.ts"], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  try {
    return await new Promise<number | null>((done) => {
      let out = "";
      const bail = setTimeout(() => done(null), 60_000);
      child.stdout!.setEncoding("utf-8");
      child.stdout!.on("data", (chunk: string) => {
        out += chunk;
        const m = /TINA4_SCHED_POLICY=(\d+)/.exec(out);
        if (m) {
          clearTimeout(bail);
          done(Number(m[1]));
        }
      });
      child.once("exit", () => {
        clearTimeout(bail);
        const m = /TINA4_SCHED_POLICY=(\d+)/.exec(out);
        done(m ? Number(m[1]) : null);
      });
    });
  } finally {
    try {
      if (child.pid && child.exitCode === null) killProcessTree(child.pid);
    } catch { /* already gone */ }
    removeTempDir(root);
  }
}

console.log("=== Production cluster scheduling policy ===\n");

// Cluster mode only engages with more than one CPU; without that there is
// nothing to schedule and the cases below would not exercise the code.
assert("this host has more than one CPU, so cluster mode engages", cpus().length > 1,
  `cpus=${cpus().length}`);

const byDefault = await primaryPolicy(undefined);
assert("with NODE_CLUSTER_SCHED_POLICY unset the primary uses round-robin (SCHED_RR)",
  byDefault === cluster.SCHED_RR, `got ${byDefault} (SCHED_RR=${cluster.SCHED_RR}, SCHED_NONE=${cluster.SCHED_NONE})`);

const explicitNone = await primaryPolicy("none");
assert("an explicit NODE_CLUSTER_SCHED_POLICY=none is respected (SCHED_NONE)",
  explicitNone === cluster.SCHED_NONE, `got ${explicitNone}`);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
