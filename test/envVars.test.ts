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
  isSecureScheme,
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
//
// Rewritten 2026-08-13 alongside the shared logger_contract.json conformance
// pass. Two load-bearing changes throughout this section:
//   1. Log.configure() now resolves and CACHES one stable snapshot (LOG-C05) —
//      a later process.env.TINA4_LOG_* mutation is IGNORED until Log.reset()
//      is called, the opposite of the old "every call re-reads the
//      environment" contract this file used to assume. Every env change below
//      is now followed by Log.reset() before the next Log.* call.
//   2. TINA4_LOG_ROTATE_SIZE has a real 1024-byte minimum (LOG-V02) — the old
//      "200" test value and the old "0 disables rotation" escape hatch are
//      both now configuration ERRORS rather than silently honoured.
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
Log.reset();

Log.info("default-format-message");
const appLogPath = join(logDir, "app.log");
assert("TINA4_LOG_FILE/_DIR creates target file", existsSync(appLogPath));
const appContent0 = readFileSync(appLogPath, "utf-8");
assert("default format is text (no JSON brace prefix)",
  appContent0.split("\n")[0].startsWith(new Date().toISOString().slice(0, 4)));

// JSON format — env changed, so reset() before the next call (LOG-C05/C06).
process.env.TINA4_LOG_FORMAT = "json";
Log.reset();
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
Log.reset();

// CRITICAL — first-class, ALWAYS emits (TINA4_LOG_CRITICAL toggle retired).
// With no toggle set, critical() must still write a line.
delete process.env.TINA4_LOG_CRITICAL;
Log.reset();
const sizeBeforeCritical = statSync(appLogPath).size;
Log.critical("always-emits");
assert("CRITICAL always emits (no toggle needed)", statSync(appLogPath).size > sizeBeforeCritical);

// The retired env var is now a REMOVED setting (LOG-V04): merely being
// present hard-fails configuration rather than being silently tolerated.
process.env.TINA4_LOG_CRITICAL = "false";
Log.reset();
let criticalRemovedThrew: unknown = null;
try {
  Log.critical("must not emit — configuration must fail first");
} catch (err) {
  criticalRemovedThrew = err;
}
assert(
  "TINA4_LOG_CRITICAL present (even falsy) now hard-fails configuration (LOG-V04)",
  criticalRemovedThrew instanceof Error && /TINA4_LOG_CRITICAL/.test((criticalRemovedThrew as Error).message),
  String(criticalRemovedThrew),
);
delete process.env.TINA4_LOG_CRITICAL;
Log.reset();

// OUTPUT modes — env changed, reset() before the next call.
process.env.TINA4_LOG_OUTPUT = "file";
Log.reset();
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
Log.reset();

// ── logger.ts: TINA4_LOG_ROTATE_SIZE + TINA4_LOG_ROTATE_KEEP ──────
console.log("\n--- TINA4_LOG_ROTATE_SIZE + _KEEP ---");

const rotDir = mkdtempSync(join(tmpdir(), "tina4-rotate-"));
process.env.TINA4_LOG_DIR = rotDir;
process.env.TINA4_LOG_FILE = "rot.log";
process.env.TINA4_DEBUG = "true";

// Minimum is 1024 bytes now (LOG-V02) — sized so ~8 messages of ~120 bytes
// each cross it more than once, still exercising real rotation.
process.env.TINA4_LOG_ROTATE_SIZE = "1024";
process.env.TINA4_LOG_ROTATE_KEEP = "3";
process.env.TINA4_LOG_OUTPUT = "file"; // silence stdout for the rotation loop
Log.reset();

const rotPath = join(rotDir, "rot.log");
for (let i = 0; i < 20; i++) {
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
process.env.TINA4_LOG_ROTATE_SIZE = "1024";
process.env.TINA4_LOG_ROTATE_KEEP = "2";
process.env.TINA4_LOG_OUTPUT = "file";
Log.reset();

const rot2Path = join(rotDir2, "rot2.log");
for (let i = 0; i < 20; i++) {
  Log.info(`keep2-message-${i} ${"x".repeat(80)}`);
}
assert("KEEP=2 retains .1", existsSync(`${rot2Path}.1`));
assert("KEEP=2 retains .2", existsSync(`${rot2Path}.2`));
assert("KEEP=2 drops .3", !existsSync(`${rot2Path}.3`));

// _SIZE=0 is now a CONFIGURATION ERROR (LOG-V02), not "disable rotation" —
// the pre-3.13.99 escape hatch is gone; this proves the new reject.
delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_ROTATE_KEEP;
delete process.env.TINA4_LOG_OUTPUT;
rmSync(rotDir2, { recursive: true, force: true });

const noRotDir = mkdtempSync(join(tmpdir(), "tina4-norot-"));
process.env.TINA4_LOG_DIR = noRotDir;
process.env.TINA4_LOG_FILE = "norot.log";
process.env.TINA4_LOG_ROTATE_SIZE = "0";
process.env.TINA4_LOG_OUTPUT = "file";
Log.reset();

let sizeZeroThrew: unknown = null;
try {
  Log.info("must not emit — configuration must fail first");
} catch (err) {
  sizeZeroThrew = err;
}
assert(
  "TINA4_LOG_ROTATE_SIZE=0 now hard-fails configuration (LOG-V02, was 'disable rotation')",
  sizeZeroThrew instanceof Error && /TINA4_LOG_ROTATE_SIZE/.test((sizeZeroThrew as Error).message),
  String(sizeZeroThrew),
);
const noRotPath = join(noRotDir, "norot.log");
assert("SIZE=0 rejected before any file is written", !existsSync(noRotPath));

delete process.env.TINA4_LOG_ROTATE_SIZE;
delete process.env.TINA4_LOG_FILE;
delete process.env.TINA4_LOG_DIR;
delete process.env.TINA4_LOG_OUTPUT;
delete process.env.TINA4_DEBUG;
Log.reset();
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

// ── session.ts: proxy-aware Secure (nodejs#34, pure-function lock-in) ─────
// isSecureScheme — parity with PHP Request::isSecureScheme.
assert("isSecureScheme('https') is true", isSecureScheme("https") === true);
assert("isSecureScheme('http') is false", isSecureScheme("http") === false);
assert("isSecureScheme('') no native TLS is false", isSecureScheme("") === false);
assert("isSecureScheme('', encrypted) is true", isSecureScheme("", true) === true);
assert("isSecureScheme chain 'https, http' first hop wins",
  isSecureScheme("https, http") === true);
assert("isSecureScheme chain 'http, https' first hop http is false",
  isSecureScheme("http, https") === false);
assert("isSecureScheme is case-insensitive", isSecureScheme("HTTPS") === true);

// buildSessionCookie threads the scheme in and honours SameSite=None.
const cookieXfpHttps = buildSessionCookie("abc123", 3600, undefined, "https");
assert("buildSessionCookie(forwardedProto=https) emits Secure",
  cookieXfpHttps.includes("Secure"));
const cookieXfpHttp = buildSessionCookie("abc123", 3600, undefined, "http");
assert("buildSessionCookie(forwardedProto=http) does NOT emit Secure",
  !cookieXfpHttp.includes("Secure"));
const cookieNativeTls = buildSessionCookie("abc123", 3600, undefined, "", true);
assert("buildSessionCookie(socketEncrypted) emits Secure",
  cookieNativeTls.includes("Secure"));
const cookieNoScheme = buildSessionCookie("abc123", 3600);
assert("buildSessionCookie with no scheme signal does NOT emit Secure",
  !cookieNoScheme.includes("Secure"));

process.env.TINA4_SESSION_SAMESITE = "None";
const cookieSameSiteNone = buildSessionCookie("abc123", 3600);
assert("SameSite=None forces Secure (RFC)",
  cookieSameSiteNone.includes("SameSite=None") && cookieSameSiteNone.includes("Secure"));
delete process.env.TINA4_SESSION_SAMESITE;

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
