/**
 * MCP enable-gate tests — the remote/localhost guard on the /__dev/mcp endpoint.
 * Run with: npx tsx test/mcpGate.test.ts
 *
 * Canonical semantics (Python master tina4_python.mcp.is_enabled()):
 *   explicit = TINA4_MCP
 *   if explicit set and non-empty: return truthy(explicit)   # ANY host
 *   if not truthy(TINA4_DEBUG): return false
 *   return isLocalhost() OR truthy(TINA4_MCP_REMOTE)          # dev = localhost-only
 *
 * WHY this matters: the MCP dev tools expose powerful operations (DB query,
 * file read/WRITE, route listing). On a non-localhost TINA4_DEBUG=true
 * deployment they must NOT auto-expose without an explicit opt-in.
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

// 1. Localhost dev (default port host) → enabled.
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "localhost:7148" });
assert("localhost + debug → enabled", mcpEnabled() === true);

// 2. Remote host + debug, no remote opt-in → DISABLED (the security gap this closes).
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "myserver.example.com:7148" });
assert("remote + debug, no opt-in → disabled", mcpEnabled() === false);

// 3. Remote host + debug + TINA4_MCP_REMOTE=true → enabled (documented escape hatch).
setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "myserver.example.com:7148", TINA4_MCP_REMOTE: "true" });
assert("remote + debug + MCP_REMOTE → enabled", mcpEnabled() === true);

// 4. Explicit TINA4_MCP=true on a remote, debug-OFF host → enabled (sysadmin opt-in, any host).
setEnv({ TINA4_MCP: "true", TINA4_HOST_NAME: "myserver.example.com:7148" });
assert("explicit MCP=true on remote, no debug → enabled", mcpEnabled() === true);

// 5. Explicit TINA4_MCP=false on localhost + debug → DISABLED (explicit off wins everywhere).
setEnv({ TINA4_MCP: "false", TINA4_DEBUG: "true", TINA4_HOST_NAME: "localhost:7148" });
assert("explicit MCP=false on localhost+debug → disabled", mcpEnabled() === false);

// 6. No debug, no explicit → DISABLED (default off).
setEnv({ TINA4_HOST_NAME: "localhost:7148" });
assert("no debug, no explicit → disabled", mcpEnabled() === false);

// Extra coverage — the localhost set members all auto-enable under debug.
for (const host of ["127.0.0.1:7148", "0.0.0.0:7148", "::1", ""]) {
  setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: host });
  assert(`localhost-set host "${host}" + debug → enabled`, mcpEnabled() === true);
}

// Extra coverage — TINA4_MCP_REMOTE alone (no debug) does NOT enable.
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
