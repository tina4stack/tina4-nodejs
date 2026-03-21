/**
 * Unit tests for port/host configuration resolution.
 * Run with: npx tsx test/portConfig.test.ts
 */
import { resolvePortAndHost } from "../packages/core/src/index.ts";

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

// Save original env values so we can restore them
const origPort = process.env.PORT;
const origHost = process.env.HOST;

function clearEnv() {
  delete process.env.PORT;
  delete process.env.HOST;
}

console.log("=== Port/Host Config Tests ===\n");

// --- Defaults (no config, no env) ---
console.log("--- Defaults ---");
clearEnv();

const defaults = resolvePortAndHost();
assert("Default port is 7148", defaults.port === 7148, `got ${defaults.port}`);
assert("Default host is 0.0.0.0", defaults.host === "0.0.0.0", `got ${defaults.host}`);

const defaultsEmpty = resolvePortAndHost({});
assert("Empty config defaults port to 7148", defaultsEmpty.port === 7148, `got ${defaultsEmpty.port}`);
assert("Empty config defaults host to 0.0.0.0", defaultsEmpty.host === "0.0.0.0", `got ${defaultsEmpty.host}`);

// --- ENV vars as fallback ---
console.log("\n--- ENV vars ---");
clearEnv();
process.env.PORT = "9000";
process.env.HOST = "127.0.0.1";

const fromEnv = resolvePortAndHost();
assert("PORT env var is picked up", fromEnv.port === 9000, `got ${fromEnv.port}`);
assert("HOST env var is picked up", fromEnv.host === "127.0.0.1", `got ${fromEnv.host}`);

const fromEnvEmpty = resolvePortAndHost({});
assert("PORT env var with empty config", fromEnvEmpty.port === 9000, `got ${fromEnvEmpty.port}`);
assert("HOST env var with empty config", fromEnvEmpty.host === "127.0.0.1", `got ${fromEnvEmpty.host}`);

// --- Explicit config overrides ENV ---
console.log("\n--- Config overrides ENV ---");
process.env.PORT = "9000";
process.env.HOST = "127.0.0.1";

const fromConfig = resolvePortAndHost({ port: 4000, host: "192.168.1.1" });
assert("Explicit port overrides PORT env", fromConfig.port === 4000, `got ${fromConfig.port}`);
assert("Explicit host overrides HOST env", fromConfig.host === "192.168.1.1", `got ${fromConfig.host}`);

// --- Partial config (port set, host from env) ---
console.log("\n--- Partial config ---");
process.env.PORT = "9000";
process.env.HOST = "10.0.0.1";

const partial = resolvePortAndHost({ port: 5555 });
assert("Partial: explicit port used", partial.port === 5555, `got ${partial.port}`);
assert("Partial: host falls back to HOST env", partial.host === "10.0.0.1", `got ${partial.host}`);

// --- Restore env ---
clearEnv();
if (origPort !== undefined) process.env.PORT = origPort;
if (origHost !== undefined) process.env.HOST = origHost;

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
