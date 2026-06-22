/**
 * MCP capability-gate tests — mcpEnabled() after the 3.13.40 split.
 * Run with: npx tsx test/mcpGate.test.ts
 *
 * Canonical semantics (Python master tina4_python.mcp.is_enabled()):
 *   explicit = TINA4_MCP
 *   if explicit set and non-empty: return truthy(explicit)   # ANY host
 *   return truthy(TINA4_DEBUG)                                # host-INDEPENDENT
 *
 * mcpEnabled() is now a pure CAPABILITY gate — it no longer consults the host.
 * A remote caller is stopped by the per-request gate (isRequestAllowed, see
 * mcpSecurity.test.ts), not by flipping the capability off on a public host.
 * This file locks the capability predicate; the regression guard is that a
 * 0.0.0.0 host no longer flips it (the old isLocalhost-based gate treated
 * 0.0.0.0 as local, which is exactly what exposed the dev tools).
 */
import { mcpEnabled } from "@tina4/core";

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

// Snapshot the env keys we mutate so each case starts clean.
const KEYS = ["TINA4_MCP", "TINA4_DEBUG", "TINA4_MCP_REMOTE", "TINA4_HOST_NAME"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

console.log("MCP Enable-Gate Matrix");

// 1. Localhost dev → enabled.
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "localhost:7148" });
assert("localhost + debug → enabled", mcpEnabled() === true);

// 2. Remote host + debug → ENABLED (capability is host-independent now).
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "myserver.example.com:7148" });
assert("remote + debug → capability enabled (host-independent)", mcpEnabled() === true);

// 3. A configured 0.0.0.0 host does NOT flip the gate (regression — old code
//    routed mcpEnabled through isLocalhost which treated 0.0.0.0 as local).
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "0.0.0.0:7148" });
assert("0.0.0.0 host + debug → enabled (host ignored)", mcpEnabled() === true);

// 4. Explicit TINA4_MCP=true on a remote, debug-OFF host → enabled (sysadmin opt-in, any host).
setEnv({ TINA4_MCP: "true", TINA4_HOST_NAME: "myserver.example.com:7148" });
assert("explicit MCP=true on remote, no debug → enabled", mcpEnabled() === true);

// 5. Explicit TINA4_MCP=false on localhost + debug → DISABLED (explicit off wins everywhere).
setEnv({ TINA4_MCP: "false", TINA4_DEBUG: "true", TINA4_HOST_NAME: "localhost:7148" });
assert("explicit MCP=false on localhost+debug → disabled", mcpEnabled() === false);

// 6. No debug, no explicit → DISABLED (default off).
setEnv({ TINA4_HOST_NAME: "localhost:7148" });
assert("no debug, no explicit → disabled", mcpEnabled() === false);

// Extra coverage — TINA4_MCP_REMOTE alone (no debug) does NOT enable the capability.
setEnv({ TINA4_MCP_REMOTE: "true", TINA4_HOST_NAME: "myserver.example.com:7148" });
assert("MCP_REMOTE without debug → disabled", mcpEnabled() === false);

// Restore the original env.
for (const k of KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}

console.log(`\nMCP Gate Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
