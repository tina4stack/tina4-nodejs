/**
 * MCP security guard tests (3.13.40 P0 — Node mirror of the Python master
 * tests/test_mcp_security.py, the PHP McpSecurityTest, and the Ruby
 * mcp_security_spec.rb).
 *
 * Locks the capability / per-request authorisation split (isLoopback +
 * isRequestAllowed), the read-only guard on database_query, and the identifier
 * guard on database_columns. Regression cover for the audit finding that a
 * 0.0.0.0-bound TINA4_DEBUG box exposed the MCP tool registry to remote
 * unauthenticated callers. isRequestAllowed operates on the RAW socket peer;
 * the devAdmin handlers feed it req.socket.remoteAddress (never X-Forwarded-For).
 *
 * Run with: npx tsx test/mcpSecurity.test.ts
 */
import { isLoopback, isRequestAllowed, McpServer, registerDevTools } from "@tina4/core";
import { initDatabase, closeDatabase } from "../packages/orm/src/index.js";

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

const KEYS = ["TINA4_MCP", "TINA4_DEBUG", "TINA4_MCP_REMOTE", "TINA4_HOST_NAME"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
function setEnv(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

console.log("MCP Security Guard");

// ── isLoopback ───────────────────────────────────────────────
for (const ip of ["127.0.0.1", "127.0.0.5", "::1", "::ffff:127.0.0.1", "localhost", "", null, undefined]) {
  assert(`isLoopback(${JSON.stringify(ip)}) → true`, isLoopback(ip) === true);
}
for (const ip of ["0.0.0.0", "1.2.3.4", "10.0.0.5", "192.168.1.10", "::ffff:1.2.3.4", "2001:db8::1", "203.0.113.9"]) {
  assert(`isLoopback("${ip}") → false (0.0.0.0 is a bind addr)`, isLoopback(ip) === false);
}

// ── isRequestAllowed ─────────────────────────────────────────
setEnv({});
assert("disabled denies even loopback", isRequestAllowed("127.0.0.1") === false);

setEnv({ TINA4_DEBUG: "true" });
assert("loopback allowed when enabled", isRequestAllowed("127.0.0.1") === true);
assert("in-process (empty) allowed when enabled", isRequestAllowed("") === true);
assert("remote denied without opt-in", isRequestAllowed("1.2.3.4") === false);

setEnv({ TINA4_DEBUG: "true", TINA4_MCP_REMOTE: "true" });
assert("remote denied without token", isRequestAllowed("1.2.3.4", false) === false);
assert("remote allowed with opt-in + token", isRequestAllowed("1.2.3.4", true) === true);

setEnv({ TINA4_DEBUG: "true", TINA4_HOST_NAME: "0.0.0.0:7148" });
assert("0.0.0.0 bind host does NOT admit remote (regression)", isRequestAllowed("203.0.113.9") === false);

// Restore env before the DB section.
for (const k of KEYS) {
  if (saved[k] === undefined) delete process.env[k];
  else process.env[k] = saved[k];
}

// ── database_query read-only guard + database_columns identifier guard ──
async function dbGuards() {
  const db = await initDatabase({ url: "sqlite::memory:" });
  try {
    await db.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)");
    await db.execute("INSERT INTO widgets (id, name) VALUES (1, 'sprocket')");

    const server = new McpServer("/test-mcp-security", "MCP Security Test");
    registerDevTools(server);

    const call = async (name: string, args: Record<string, unknown>) => {
      const resp = JSON.parse(
        await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      );
      return JSON.parse(resp.result.content[0].text);
    };

    assert("database_query allows SELECT", Array.isArray((await call("database_query", { sql: "SELECT id FROM widgets" })).records));

    const upd = await call("database_query", { sql: "UPDATE widgets SET name='x'" });
    assert("database_query rejects UPDATE (read-only)", String(upd.error || "").toLowerCase().includes("read-only"), JSON.stringify(upd));

    assert("database_query rejects DELETE", typeof (await call("database_query", { sql: "DELETE FROM widgets" })).error === "string");
    assert("database_query rejects DROP", typeof (await call("database_query", { sql: "DROP TABLE widgets" })).error === "string");

    const stacked = await call("database_query", { sql: "SELECT 1; DROP TABLE widgets" });
    assert("database_query rejects stacked statements", String(stacked.error || "").toLowerCase().includes("multiple statements"), JSON.stringify(stacked));

    const bound = await call("database_query", { sql: "SELECT name FROM widgets WHERE id = ?", params: "[1]" });
    assert("database_query binds params (regression)", Array.isArray(bound.records) && bound.records[0]?.name === "sprocket", JSON.stringify(bound));

    const badCol = await call("database_columns", { table: "widgets; DROP TABLE widgets" });
    assert("database_columns rejects injection-shaped table", String(badCol.error || "").toLowerCase().includes("invalid table"), JSON.stringify(badCol));

    // Verify the rejected writes never touched the data.
    const stillThere = await call("database_query", { sql: "SELECT name FROM widgets WHERE id = 1" });
    assert("rejected writes left the row intact", stillThere.records?.[0]?.name === "sprocket", JSON.stringify(stillThere));
  } finally {
    closeDatabase();
    delete (globalThis as any).__tina4_db;
  }
}

await dbGuards();

console.log(`\nMCP Security Tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
