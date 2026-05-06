/**
 * Cross-framework env-var parity tests for v3.12.4.
 *
 * Covers the 25 env vars added/wired into Tina4 Node.js: each gets a
 * default-value test and an override test, plus log-rotation tests
 * (size cutoff, keep cap, disable).
 *
 * Run with: npx tsx test/envVars.test.ts
 */
import {
  buildSessionCookie,
  graphqlAutoSchemaEnabled,
  graphqlEndpoint,
  healthPath,
  isBannerSuppressed,
  isTrailingSlashRedirectEnabled,
  loadEnv,
  Log,
  mcpEnabled,
  mcpPort,
  resetEnv,
  resolvePortAndHost,
} from "../packages/core/src/index.ts";
import { Frond } from "../packages/frond/src/engine.ts";
import { Messenger } from "../packages/core/src/messenger.ts";
import { swaggerEnabled, generate } from "../packages/swagger/src/index.ts";
import { resolveDbPool } from "../packages/orm/src/index.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

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

/**
 * Stash + restore process.env between scenarios. We can't simply replace
 * the object — Node's runtime re-reads process.env keys via getter — so we
 * snapshot the keys we touch and restore them at teardown.
 */
const TRACKED_KEYS = [
  "TINA4_HOST", "TINA4_SUPPRESS", "TINA4_ENV_FILE",
  "TINA4_HEALTH_PATH", "TINA4_TRAILING_SLASH_REDIRECT",
  "TINA4_LOG_FILE", "TINA4_LOG_DIR", "TINA4_LOG_FORMAT", "TINA4_LOG_OUTPUT",
  "TINA4_LOG_CRITICAL", "TINA4_LOG_ROTATE_SIZE", "TINA4_LOG_ROTATE_KEEP",
  "TINA4_LOG_LEVEL", "TINA4_DEBUG",
  "TINA4_SESSION_HTTPONLY", "TINA4_SESSION_NAME", "TINA4_SESSION_SECURE",
  "TINA4_SESSION_SAMESITE",
  "TINA4_TEMPLATE_CACHE_TTL",
  "TINA4_GRAPHQL_AUTO_SCHEMA", "TINA4_GRAPHQL_ENDPOINT",
  "TINA4_MAIL_IMAP_ENCRYPTION",
  "TINA4_MCP", "TINA4_MCP_PORT",
  "TINA4_SWAGGER_CONTACT_EMAIL", "TINA4_SWAGGER_ENABLED", "TINA4_SWAGGER_LICENSE",
  "TINA4_DB_POOL",
  "HOST", "PORT",
];

function snapshot(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of TRACKED_KEYS) snap[k] = process.env[k];
  return snap;
}

function restore(snap: Record<string, string | undefined>): void {
  for (const k of TRACKED_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function clearAll(): void {
  for (const k of TRACKED_KEYS) delete process.env[k];
}

const ENV_SNAPSHOT = snapshot();
clearAll();

console.log("=== Env Var Wiring Tests ===\n");

// ── server.ts: TINA4_HOST + TINA4_SUPPRESS ─────────────────────────
console.log("--- TINA4_HOST + TINA4_SUPPRESS ---");

assert("TINA4_HOST default is 0.0.0.0", resolvePortAndHost().host === "0.0.0.0");
process.env.TINA4_HOST = "127.0.0.1";
assert("TINA4_HOST override honoured", resolvePortAndHost().host === "127.0.0.1");
delete process.env.TINA4_HOST;

assert("TINA4_SUPPRESS default is false", isBannerSuppressed() === false);
process.env.TINA4_SUPPRESS = "true";
assert("TINA4_SUPPRESS=true honoured", isBannerSuppressed() === true);
delete process.env.TINA4_SUPPRESS;

// ── dotenv.ts: TINA4_ENV_FILE ──────────────────────────────────────
console.log("\n--- TINA4_ENV_FILE ---");

const envDir = mkdtempSync(join(tmpdir(), "tina4-envfile-"));
const customEnvPath = join(envDir, "custom.env");
writeFileSync(customEnvPath, "TINA4_TEST_FROM_CUSTOM=yes\n");
const defaultEnvPath = join(envDir, ".env");
writeFileSync(defaultEnvPath, "TINA4_TEST_FROM_DEFAULT=yes\n");

resetEnv();
delete process.env.TINA4_TEST_FROM_DEFAULT;
delete process.env.TINA4_TEST_FROM_CUSTOM;

// Default — explicit path argument honoured
loadEnv(defaultEnvPath);
assert("loadEnv() honours explicit path", process.env.TINA4_TEST_FROM_DEFAULT === "yes");

resetEnv();
delete process.env.TINA4_TEST_FROM_DEFAULT;
delete process.env.TINA4_TEST_FROM_CUSTOM;

// Override via env var
process.env.TINA4_ENV_FILE = customEnvPath;
loadEnv();
assert("TINA4_ENV_FILE override honoured", process.env.TINA4_TEST_FROM_CUSTOM === "yes");
delete process.env.TINA4_ENV_FILE;
delete process.env.TINA4_TEST_FROM_DEFAULT;
delete process.env.TINA4_TEST_FROM_CUSTOM;
rmSync(envDir, { recursive: true, force: true });

// ── health.ts: TINA4_HEALTH_PATH ───────────────────────────────────
console.log("\n--- TINA4_HEALTH_PATH ---");

assert("TINA4_HEALTH_PATH default is /__health", healthPath() === "/__health");
process.env.TINA4_HEALTH_PATH = "/api/healthz";
assert("TINA4_HEALTH_PATH override honoured", healthPath() === "/api/healthz");
process.env.TINA4_HEALTH_PATH = "alive";
assert("TINA4_HEALTH_PATH adds leading slash", healthPath() === "/alive");
delete process.env.TINA4_HEALTH_PATH;

// ── router.ts: TINA4_TRAILING_SLASH_REDIRECT ───────────────────────
console.log("\n--- TINA4_TRAILING_SLASH_REDIRECT ---");

assert("TINA4_TRAILING_SLASH_REDIRECT default false", isTrailingSlashRedirectEnabled() === false);
process.env.TINA4_TRAILING_SLASH_REDIRECT = "true";
assert("TINA4_TRAILING_SLASH_REDIRECT=true honoured", isTrailingSlashRedirectEnabled() === true);
delete process.env.TINA4_TRAILING_SLASH_REDIRECT;

// ── logger.ts: TINA4_LOG_FILE / DIR / FORMAT / OUTPUT / CRITICAL ───
console.log("\n--- TINA4_LOG_* (file, dir, format, output, critical) ---");

const logDir = mkdtempSync(join(tmpdir(), "tina4-log-"));
process.env.TINA4_LOG_DIR = logDir;
process.env.TINA4_LOG_FILE = "app.log";
process.env.TINA4_DEBUG = "true";
delete process.env.TINA4_LOG_FORMAT;
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_ROTATE_KEEP;
delete process.env.TINA4_LOG_CRITICAL;

Log.info("default-format-message");
const appLogPath = join(logDir, "app.log");
assert("TINA4_LOG_FILE/_DIR creates target file", existsSync(appLogPath));
const appContent0 = readFileSync(appLogPath, "utf-8");
assert("default format is text (no JSON brace prefix)",
  appContent0.split("\n")[0].startsWith(new Date().toISOString().slice(0, 4)));

// JSON format
process.env.TINA4_LOG_FORMAT = "json";
Log.info("json-message", { id: 1 });
const appContentJson = readFileSync(appLogPath, "utf-8");
const lines = appContentJson.trim().split("\n");
const lastLine = lines[lines.length - 1];
let parsed: any = null;
try { parsed = JSON.parse(lastLine); } catch { /* empty */ }
assert("TINA4_LOG_FORMAT=json emits valid JSON", parsed !== null);
assert("JSON line carries level + message",
  parsed?.level === "INFO" && parsed?.message === "json-message");
delete process.env.TINA4_LOG_FORMAT;

// CRITICAL — disabled by default
const sizeBeforeCritical = statSync(appLogPath).size;
Log.critical("should-not-emit");
assert("CRITICAL suppressed by default", statSync(appLogPath).size === sizeBeforeCritical);

process.env.TINA4_LOG_CRITICAL = "true";
Log.critical("now-emits");
const sizeAfterCritical = statSync(appLogPath).size;
assert("TINA4_LOG_CRITICAL=true enables CRITICAL", sizeAfterCritical > sizeBeforeCritical);
delete process.env.TINA4_LOG_CRITICAL;

// OUTPUT modes
process.env.TINA4_LOG_OUTPUT = "file";
const origConsole = console.log;
let captured = "";
console.log = (...args: unknown[]) => { captured += args.join(" "); };
Log.info("file-only");
console.log = origConsole;
assert("TINA4_LOG_OUTPUT=file silences stdout", captured === "");
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_DIR;
delete process.env.TINA4_DEBUG;

// ── logger.ts: TINA4_LOG_ROTATE_SIZE + TINA4_LOG_ROTATE_KEEP ──────
console.log("\n--- TINA4_LOG_ROTATE_SIZE + _KEEP ---");

const rotDir = mkdtempSync(join(tmpdir(), "tina4-rotate-"));
process.env.TINA4_LOG_DIR = rotDir;
process.env.TINA4_LOG_FILE = "rot.log";
process.env.TINA4_DEBUG = "true";

// Tiny size so we trigger rotation quickly. Each Log.info() writes ~120 bytes,
// so 200 bytes per file means rotation after every 1-2 messages.
process.env.TINA4_LOG_ROTATE_SIZE = "200";
process.env.TINA4_LOG_ROTATE_KEEP = "3";
process.env.TINA4_LOG_OUTPUT = "file"; // silence stdout for the rotation loop

const rotPath = join(rotDir, "rot.log");
for (let i = 0; i < 8; i++) {
  Log.info(`rotation-message-${i} ${"x".repeat(80)}`);
}

assert("rotation creates rot.log.1", existsSync(`${rotPath}.1`));
assert("rotation honours KEEP (no .4 file)", !existsSync(`${rotPath}.4`));
const rotFiles = readdirSync(rotDir).filter((f) => f.startsWith("rot.log")).sort();
assert("at most KEEP+1 files exist", rotFiles.length <= 4); // current + 3 backups
assert("current rot.log exists", existsSync(rotPath));

// _KEEP=2 — fewer backups retained
delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_ROTATE_KEEP;
delete process.env.TINA4_LOG_OUTPUT;
rmSync(rotDir, { recursive: true, force: true });

const rotDir2 = mkdtempSync(join(tmpdir(), "tina4-rotate2-"));
process.env.TINA4_LOG_DIR = rotDir2;
process.env.TINA4_LOG_FILE = "rot2.log";
process.env.TINA4_LOG_ROTATE_SIZE = "200";
process.env.TINA4_LOG_ROTATE_KEEP = "2";
process.env.TINA4_LOG_OUTPUT = "file";

const rot2Path = join(rotDir2, "rot2.log");
for (let i = 0; i < 8; i++) {
  Log.info(`keep2-message-${i} ${"x".repeat(80)}`);
}
assert("KEEP=2 retains .1", existsSync(`${rot2Path}.1`));
assert("KEEP=2 retains .2", existsSync(`${rot2Path}.2`));
assert("KEEP=2 drops .3", !existsSync(`${rot2Path}.3`));

// _SIZE=0 disables rotation
delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_ROTATE_KEEP;
delete process.env.TINA4_LOG_OUTPUT;
rmSync(rotDir2, { recursive: true, force: true });

const noRotDir = mkdtempSync(join(tmpdir(), "tina4-norot-"));
process.env.TINA4_LOG_DIR = noRotDir;
process.env.TINA4_LOG_FILE = "norot.log";
process.env.TINA4_LOG_ROTATE_SIZE = "0";
process.env.TINA4_LOG_OUTPUT = "file"; // silence the burst-writes loop

for (let i = 0; i < 50; i++) {
  Log.info(`no-rotate-${i} ${"y".repeat(120)}`);
}
const noRotPath = join(noRotDir, "norot.log");
assert("SIZE=0 disables rotation (no .1 file)", !existsSync(`${noRotPath}.1`));
const noRotSize = statSync(noRotPath).size;
assert("SIZE=0 keeps appending to single file", noRotSize > 5_000);

delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_DIR;
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_DEBUG;
rmSync(noRotDir, { recursive: true, force: true });

// ── session.ts: TINA4_SESSION_HTTPONLY / NAME / SECURE ─────────────
console.log("\n--- TINA4_SESSION_HTTPONLY / NAME / SECURE ---");

const cookieDefault = buildSessionCookie("abc123", 3600);
assert("session cookie default name is tina4_session",
  cookieDefault.startsWith("tina4_session="));
assert("session cookie HttpOnly default ON", cookieDefault.includes("HttpOnly"));
assert("session cookie Secure default OFF", !cookieDefault.includes("Secure"));

process.env.TINA4_SESSION_NAME = "my_sid";
const cookieRenamed = buildSessionCookie("abc123", 3600);
assert("TINA4_SESSION_NAME renames cookie",
  cookieRenamed.startsWith("my_sid=abc123"));
delete process.env.TINA4_SESSION_NAME;

process.env.TINA4_SESSION_HTTPONLY = "false";
const cookieNoHttpOnly = buildSessionCookie("abc123", 3600);
assert("TINA4_SESSION_HTTPONLY=false drops HttpOnly",
  !cookieNoHttpOnly.includes("HttpOnly"));
delete process.env.TINA4_SESSION_HTTPONLY;

process.env.TINA4_SESSION_SECURE = "true";
const cookieSecure = buildSessionCookie("abc123", 3600);
assert("TINA4_SESSION_SECURE=true emits Secure", cookieSecure.includes("Secure"));
delete process.env.TINA4_SESSION_SECURE;

// ── frond/engine.ts: TINA4_TEMPLATE_CACHE_TTL ──────────────────────
console.log("\n--- TINA4_TEMPLATE_CACHE_TTL ---");

const tplDir = mkdtempSync(join(tmpdir(), "tina4-tpl-"));
const tplFile = "page.twig";
writeFileSync(join(tplDir, tplFile), "{{ greeting }}", "utf-8");

delete process.env.TINA4_DEBUG; // make sure prod cache path runs
delete process.env.TINA4_TEMPLATE_CACHE_TTL;

const frond = new Frond(tplDir);
const out1 = frond.render(tplFile, { greeting: "hello" });
assert("default TTL=0 caches forever (first render works)", out1 === "hello");

// Mutate the template — with TTL=0 the cached version is reused.
writeFileSync(join(tplDir, tplFile), "{{ greeting }} world", "utf-8");
const out2 = frond.render(tplFile, { greeting: "hello" });
assert("TTL=0 still serves cached compiled tokens", out2 === "hello");

// TTL=1: after sleeping 1.1s, a new render hits the disk again.
process.env.TINA4_TEMPLATE_CACHE_TTL = "1";
const frond2 = new Frond(tplDir);
frond2.render(tplFile, { greeting: "hello" }); // warm
await new Promise((r) => setTimeout(r, 1100));
const out3 = frond2.render(tplFile, { greeting: "hello" });
assert("TTL>0 invalidates after window", out3 === "hello world");
delete process.env.TINA4_TEMPLATE_CACHE_TTL;
rmSync(tplDir, { recursive: true, force: true });

// ── graphql.ts: TINA4_GRAPHQL_AUTO_SCHEMA / ENDPOINT ───────────────
console.log("\n--- TINA4_GRAPHQL_* ---");

assert("TINA4_GRAPHQL_AUTO_SCHEMA default true", graphqlAutoSchemaEnabled() === true);
process.env.TINA4_GRAPHQL_AUTO_SCHEMA = "false";
assert("TINA4_GRAPHQL_AUTO_SCHEMA=false honoured", graphqlAutoSchemaEnabled() === false);
delete process.env.TINA4_GRAPHQL_AUTO_SCHEMA;

assert("TINA4_GRAPHQL_ENDPOINT default /graphql", graphqlEndpoint() === "/graphql");
process.env.TINA4_GRAPHQL_ENDPOINT = "/api/gql";
assert("TINA4_GRAPHQL_ENDPOINT override honoured", graphqlEndpoint() === "/api/gql");
process.env.TINA4_GRAPHQL_ENDPOINT = "v1/graphql";
assert("TINA4_GRAPHQL_ENDPOINT prepends slash", graphqlEndpoint() === "/v1/graphql");
delete process.env.TINA4_GRAPHQL_ENDPOINT;

// ── messenger.ts: TINA4_MAIL_IMAP_ENCRYPTION ───────────────────────
console.log("\n--- TINA4_MAIL_IMAP_ENCRYPTION ---");

delete process.env.TINA4_MAIL_IMAP_ENCRYPTION;
const m1 = new Messenger();
assert("TINA4_MAIL_IMAP_ENCRYPTION default tls", m1.getImapEncryption() === "tls");

process.env.TINA4_MAIL_IMAP_ENCRYPTION = "starttls";
const m2 = new Messenger();
assert("TINA4_MAIL_IMAP_ENCRYPTION=starttls honoured",
  m2.getImapEncryption() === "starttls");
delete process.env.TINA4_MAIL_IMAP_ENCRYPTION;

// ── mcp.ts: TINA4_MCP / TINA4_MCP_PORT ─────────────────────────────
console.log("\n--- TINA4_MCP / TINA4_MCP_PORT ---");

delete process.env.TINA4_DEBUG;
delete process.env.TINA4_MCP;
assert("TINA4_MCP default false (no debug)", mcpEnabled() === false);

process.env.TINA4_DEBUG = "true";
assert("TINA4_MCP default true when DEBUG=true", mcpEnabled() === true);

process.env.TINA4_MCP = "false";
assert("TINA4_MCP=false overrides DEBUG=true", mcpEnabled() === false);
delete process.env.TINA4_MCP;
delete process.env.TINA4_DEBUG;

assert("TINA4_MCP_PORT default = port + 2000", mcpPort(7148) === 9148);
process.env.TINA4_MCP_PORT = "5500";
assert("TINA4_MCP_PORT override honoured", mcpPort(7148) === 5500);
delete process.env.TINA4_MCP_PORT;

// ── swagger: TINA4_SWAGGER_CONTACT_EMAIL / ENABLED / LICENSE ──────
console.log("\n--- TINA4_SWAGGER_* ---");

delete process.env.TINA4_DEBUG;
delete process.env.TINA4_SWAGGER_ENABLED;
assert("TINA4_SWAGGER_ENABLED default off without debug",
  swaggerEnabled() === false);

process.env.TINA4_DEBUG = "true";
assert("TINA4_SWAGGER_ENABLED default on with debug",
  swaggerEnabled() === true);

process.env.TINA4_SWAGGER_ENABLED = "false";
assert("TINA4_SWAGGER_ENABLED=false overrides DEBUG=true",
  swaggerEnabled() === false);
delete process.env.TINA4_SWAGGER_ENABLED;
delete process.env.TINA4_DEBUG;

process.env.TINA4_SWAGGER_CONTACT_EMAIL = "team@example.com";
const specWithEmail = generate([], []) as any;
assert("TINA4_SWAGGER_CONTACT_EMAIL surfaces in info.contact",
  specWithEmail.info?.contact?.email === "team@example.com");
delete process.env.TINA4_SWAGGER_CONTACT_EMAIL;

process.env.TINA4_SWAGGER_LICENSE = "MIT";
const specMit = generate([], []) as any;
assert("TINA4_SWAGGER_LICENSE plain identifier",
  specMit.info?.license?.name === "MIT");

process.env.TINA4_SWAGGER_LICENSE = "Apache-2.0|https://www.apache.org/licenses/LICENSE-2.0";
const specApache = generate([], []) as any;
assert("TINA4_SWAGGER_LICENSE Name|URL split",
  specApache.info?.license?.name === "Apache-2.0" &&
  specApache.info?.license?.url === "https://www.apache.org/licenses/LICENSE-2.0");
delete process.env.TINA4_SWAGGER_LICENSE;

const specNoEmail = generate([], []) as any;
assert("default omits info.contact when no email",
  specNoEmail.info?.contact === undefined);

// ── orm/database.ts: TINA4_DB_POOL ────────────────────────────────
console.log("\n--- TINA4_DB_POOL ---");

delete process.env.TINA4_DB_POOL;
assert("TINA4_DB_POOL default 0 (single connection)", resolveDbPool() === 0);
process.env.TINA4_DB_POOL = "4";
assert("TINA4_DB_POOL=4 honoured", resolveDbPool() === 4);
process.env.TINA4_DB_POOL = "garbage";
assert("TINA4_DB_POOL non-numeric falls back to 0", resolveDbPool() === 0);
process.env.TINA4_DB_POOL = "-1";
assert("TINA4_DB_POOL negative falls back to 0", resolveDbPool() === 0);
delete process.env.TINA4_DB_POOL;

// ── Cleanup ───────────────────────────────────────────────────────
restore(ENV_SNAPSHOT);

// Avoid touching disk markers in subsequent tests
process.env.NODE_PATH_SEP = sep; // use sep so import isn't tree-shaken

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
