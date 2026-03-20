/**
 * Comprehensive smoke test for the Tina4 Node.js framework (v3).
 * Validates all key features work end-to-end using in-memory/temp resources.
 * Run with: npx tsx test/smoke.test.ts
 */
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── Core imports ────────────────────────────────────────────────────
import {
  Router, cors, requestLogger,
  loadEnv, getEnv, hasEnv, resetEnv,
  Log,
  rateLimiter,
  createToken, validateToken, hashPassword, checkPassword,
  Session,
  I18n,
  FakeData,
  Queue,
  GraphQL,
  computeAcceptKey, buildFrame, parseFrame, OP_TEXT,
  Events,
  matchCronField, matchesCron,
  responseCache, clearCache,
  Api,
  DevMailbox,
  WSDLService, WSDLOp,
  detectAi,
} from "../packages/core/src/index.ts";
import type { Tina4Request, Tina4Response, Middleware } from "../packages/core/src/index.ts";

// ── ORM imports ─────────────────────────────────────────────────────
import {
  initDatabase, closeDatabase, getAdapter, parseDatabaseUrl,
  validate, BaseModel, syncModels,
  ensureMigrationTable, isMigrationApplied,
  SQLTranslator,
} from "../packages/orm/src/index.ts";
import type { FieldDefinition, DiscoveredModel } from "../packages/orm/src/index.ts";

// ── Swagger imports ─────────────────────────────────────────────────
import { generateOpenAPISpec } from "../packages/swagger/src/index.ts";
import type { RouteDefinition } from "../packages/core/src/index.ts";

// ── Frond imports ───────────────────────────────────────────────────
import { Frond } from "../packages/frond/src/index.ts";

// ═══════════════════════════════════════════════════════════════════
// Test infrastructure
// ═══════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

const TMP = `/tmp/tina4-smoke-test-${Date.now()}`;
mkdirSync(TMP, { recursive: true });

// ═══════════════════════════════════════════════════════════════════
// 1. Router
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 1. Router ===\n");

const router = new Router();
const handler = async (req: Tina4Request, res: Tina4Response) => {};

router.get("/hello", handler);
router.post("/hello", handler);
router.get("/users/{id}", handler);

assert("GET /hello matches", router.match("GET", "/hello") !== null);
assert("POST /hello matches", router.match("POST", "/hello") !== null);
assert("GET /nonexistent returns null", router.match("GET", "/nope") === null);

const paramMatch = router.match("GET", "/users/42");
assert("param {id} extracted", paramMatch !== null && paramMatch.params.id === "42");

// ═══════════════════════════════════════════════════════════════════
// 2. ORM
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 2. ORM ===\n");

const DB_PATH = join(TMP, "orm.db");
await initDatabase({ type: "sqlite", path: DB_PATH });

class SmokeUser extends BaseModel {
  static tableName = "smoke_users";
  static fields: Record<string, FieldDefinition> = {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    name: { type: "string", required: true, minLength: 2 },
    email: { type: "string", required: true, pattern: "^.+@.+\\..+$" },
  };
}

const smokeModel: DiscoveredModel = {
  definition: { tableName: "smoke_users", fields: SmokeUser.fields },
  filePath: "test",
  modelClass: SmokeUser,
};
syncModels([smokeModel]);

const adapter = getAdapter();
assert("smoke_users table created", (adapter as any).tableExists("smoke_users"));

// Validation
const vErrors = validate({}, SmokeUser.fields, false);
assert("validate rejects missing required fields", vErrors.length >= 2);

const vOk = validate({ name: "Alice", email: "alice@t.com" }, SmokeUser.fields, false);
assert("validate passes valid data", vOk.length === 0);

// BaseModel CRUD
const u = new SmokeUser({ name: "Alice", email: "alice@test.com" });
u.save();
assert("BaseModel.save assigns id", (u as any).id !== undefined);

const found = SmokeUser.findById((u as any).id);
assert("BaseModel.findById retrieves record", found !== null && (found as any).name === "Alice");

const all = SmokeUser.findAll();
assert("BaseModel.findAll returns array", Array.isArray(all) && all.length === 1);

const dict = found!.toDict();
assert("toDict returns plain object", typeof dict === "object" && dict.name === "Alice");

closeDatabase();

// ═══════════════════════════════════════════════════════════════════
// 3. Database — URL parsing
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 3. Database ===\n");

const sqliteUrl = parseDatabaseUrl("sqlite:///tmp/test.db");
assert("parseDatabaseUrl sqlite type", sqliteUrl.type === "sqlite");
assert("parseDatabaseUrl sqlite path", sqliteUrl.path === "/tmp/test.db");

const pgUrl = parseDatabaseUrl("postgresql://admin:secret@db.example.com:5432/myapp");
assert("parseDatabaseUrl pg type", pgUrl.type === "postgres");
assert("parseDatabaseUrl pg host", pgUrl.host === "db.example.com");
assert("parseDatabaseUrl pg port", pgUrl.port === 5432);

// Re-init for later migration tests
const DB2_PATH = join(TMP, "migrate.db");
await initDatabase({ type: "sqlite", path: DB2_PATH });

// ═══════════════════════════════════════════════════════════════════
// 4. Frond templates
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 4. Frond Templates ===\n");

const frondDir = join(TMP, "templates");
mkdirSync(frondDir, { recursive: true });

const frond = new Frond(frondDir);

assert("render variable", frond.renderString("Hello {{ name }}", { name: "World" }) === "Hello World");
assert("dotted path", frond.renderString("{{ user.name }}", { user: { name: "Alice" } }) === "Alice");
assert("upper filter", frond.renderString("{{ n | upper }}", { n: "hello" }) === "HELLO");

// Inheritance
writeFileSync(join(frondDir, "base.html"), "<h1>{% block title %}Default{% endblock %}</h1>");
writeFileSync(join(frondDir, "child.html"), '{% extends "base.html" %}{% block title %}Custom{% endblock %}');
assert("template inheritance", frond.render("child.html", {}) === "<h1>Custom</h1>");

// ═══════════════════════════════════════════════════════════════════
// 5. Error templates
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 5. Error Templates ===\n");

const errDir = join(
  import.meta.dirname ?? "",
  "../packages/core/templates/errors",
);

assert("404 template exists", existsSync(join(errDir, "404.twig")));
assert("500 template exists", existsSync(join(errDir, "500.twig")));
assert("base template exists", existsSync(join(errDir, "base.twig")));

// ═══════════════════════════════════════════════════════════════════
// 6. Sessions
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 6. Sessions ===\n");

const sessDir = join(TMP, "sessions");
const sess = new Session("file", { path: sessDir });
const sid = sess.start();
assert("session start returns id", typeof sid === "string" && sid.length > 0);

sess.set("color", "blue");
assert("session get returns set value", sess.get("color") === "blue");

sess.destroy();
assert("session destroyed", sess.getId() === null);

// ═══════════════════════════════════════════════════════════════════
// 7. Auth/JWT
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 7. Auth/JWT ===\n");

const SECRET = "smoke-test-secret-key";

const token = createToken({ userId: 1 }, SECRET, 3600);
assert("createToken returns string", typeof token === "string");

const jwtPayload = validateToken(token, SECRET);
assert("validateToken returns payload", jwtPayload !== null && jwtPayload.userId === 1);

const expired = createToken({ userId: 1 }, SECRET, -1);
assert("expired token rejected", validateToken(expired, SECRET) === null);

const hash = hashPassword("password123");
assert("hashPassword returns string", typeof hash === "string");
assert("checkPassword correct", checkPassword("password123", hash) === true);
assert("checkPassword wrong", checkPassword("wrong", hash) === false);

// ═══════════════════════════════════════════════════════════════════
// 8. Middleware — CORS
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 8. CORS Middleware ===\n");

const corsMiddleware = cors();
assert("cors() returns a function", typeof corsMiddleware === "function");

// Simulate CORS middleware call
let corsHeaders: Record<string, string> = {};
const mockReq = {
  method: "GET",
  url: "/test",
  headers: { origin: "http://localhost" },
} as unknown as Tina4Request;
const mockRes = Object.assign(
  function (data?: unknown, code?: number) { return mockRes; },
  {
    header: (key: string, value: string) => { corsHeaders[key] = value; return mockRes; },
    raw: { writableEnded: false },
  },
) as unknown as Tina4Response;
let corsNextCalled = false;
corsMiddleware(mockReq, mockRes, () => { corsNextCalled = true; });
assert("CORS middleware calls next()", corsNextCalled);

// ═══════════════════════════════════════════════════════════════════
// 9. Queue
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 9. Queue ===\n");

const queueDir = join(TMP, "queue");
const q = new Queue("file", { path: queueDir });

const jobId = q.push("emails", { to: "bob@test.com", subject: "Hi" });
assert("push returns job id", typeof jobId === "string" && jobId.length > 0);

const job = q.pop("emails");
assert("pop returns job", job !== null);
assert("job has correct payload", job !== null && (job.payload as any).to === "bob@test.com");

const emptyJob = q.pop("emails");
assert("pop on empty queue returns null", emptyJob === null);

// ═══════════════════════════════════════════════════════════════════
// 10. GraphQL
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 10. GraphQL ===\n");

const gql = new GraphQL();
gql.addType("Product", {
  id: { type: "ID" },
  name: { type: "String" },
});

gql.addQuery("products", {}, "[Product]", () => [
  { id: "1", name: "Widget" },
]);

gql.addMutation("createProduct", { name: "String!" }, "Product", (_root, args) => {
  return { id: "2", name: args.name };
});

const schema = gql.schema();
assert("schema contains type Product", schema.includes("type Product {"));
assert("schema contains Query type", schema.includes("type Query {"));
assert("schema contains Mutation type", schema.includes("type Mutation {"));

const qr = gql.execute("{ products { id name } }");
assert("query executes and returns data", qr.data !== null);
assert("query returns products", Array.isArray((qr.data as any)?.products));

const mr = gql.execute('mutation { createProduct(name: "Gadget") { name } }');
assert("mutation returns data", (mr.data as any)?.createProduct?.name === "Gadget");

// ═══════════════════════════════════════════════════════════════════
// 11. Swagger
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 11. Swagger ===\n");

const routes: RouteDefinition[] = [
  { method: "GET", pattern: "/api/items", handler: async () => {} },
  { method: "POST", pattern: "/api/items", handler: async () => {} },
];
const models = [
  {
    tableName: "items",
    fields: {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const, required: true },
    },
  },
];

const spec = generateOpenAPISpec(routes, models);
assert("spec has openapi version", spec.openapi === "3.0.3");
assert("spec has paths", typeof spec.paths === "object");
assert("spec has /api/items path", "/api/items" in spec.paths);
assert("spec has components.schemas", spec.components?.schemas !== undefined);

// ═══════════════════════════════════════════════════════════════════
// 12. I18n
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 12. I18n ===\n");

const localeDir = join(TMP, "locales");
mkdirSync(localeDir, { recursive: true });
writeFileSync(join(localeDir, "en.json"), JSON.stringify({ greeting: "Hello", welcome: "Welcome, {name}!" }));
writeFileSync(join(localeDir, "fr.json"), JSON.stringify({ greeting: "Bonjour" }));

const i18n = new I18n(localeDir, "en");
assert("translate key", i18n.t("greeting") === "Hello");
assert("interpolation", i18n.t("welcome", { name: "Alice" }) === "Welcome, Alice!");

i18n.setLocale("fr");
assert("switch locale", i18n.t("greeting") === "Bonjour");

// ═══════════════════════════════════════════════════════════════════
// 13. FakeData
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 13. FakeData ===\n");

const seeded1 = new FakeData(42);
const seeded2 = new FakeData(42);
const name1 = seeded1.fullName();
const name2 = seeded2.fullName();
assert("seeded data is deterministic", name1 === name2);

const fake = new FakeData();
assert("firstName returns string", typeof fake.firstName() === "string" && fake.firstName().length > 0);
assert("email contains @", fake.email().includes("@"));

// ═══════════════════════════════════════════════════════════════════
// 14. Migrations
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 14. Migrations ===\n");

ensureMigrationTable();
const adapter2 = getAdapter();
assert("ensureMigrationTable creates table", (adapter2 as any).tableExists("tina4_migration"));
assert("isMigrationApplied returns false for new", !isMigrationApplied("nonexistent_migration"));

closeDatabase();

// ═══════════════════════════════════════════════════════════════════
// 15. Response Cache
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 15. Response Cache ===\n");

const cacheMw = responseCache({ ttl: 60 });
assert("responseCache returns middleware function", typeof cacheMw === "function");
clearCache();
assert("clearCache does not throw", true);

// ═══════════════════════════════════════════════════════════════════
// 16. SQL Translation
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 16. SQL Translation ===\n");

assert(
  "limitToRows converts LIMIT/OFFSET",
  SQLTranslator.limitToRows("SELECT * FROM t LIMIT 10 OFFSET 5") === "SELECT * FROM t ROWS 6 TO 15",
);
assert(
  "limitToTop converts LIMIT to TOP",
  SQLTranslator.limitToTop("SELECT * FROM t LIMIT 10") === "SELECT TOP 10 * FROM t",
);
assert(
  "booleanToInt converts TRUE/FALSE",
  SQLTranslator.booleanToInt("SELECT * WHERE active = TRUE") === "SELECT * WHERE active = 1",
);

// ═══════════════════════════════════════════════════════════════════
// 17. AI Detection
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 17. AI Detection ===\n");

const aiDir = join(TMP, "ai-test-empty");
mkdirSync(aiDir, { recursive: true });
const aiResults = detectAi(aiDir);
assert("detectAi returns array", Array.isArray(aiResults));
const aiDetected = aiResults.filter((r) => r.status === "detected");
assert("empty dir detects no AI tools", aiDetected.length === 0);

// ═══════════════════════════════════════════════════════════════════
// 18. DevMailbox
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 18. DevMailbox ===\n");

const mbDir = join(TMP, "mailbox");
const mailbox = new DevMailbox(mbDir);
assert("DevMailbox instantiates", mailbox !== null);
assert("DevMailbox.capture method exists", typeof mailbox.capture === "function");

// ═══════════════════════════════════════════════════════════════════
// 19. DotEnv
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 19. DotEnv ===\n");

const envDir = join(TMP, "envtest");
mkdirSync(envDir, { recursive: true });
writeFileSync(join(envDir, ".env"), "SMOKE_KEY=smoke_value\nSMOKE_PORT=3000\n");

resetEnv();
loadEnv(join(envDir, ".env"));
assert("getEnv reads value", getEnv("SMOKE_KEY") === "smoke_value");
assert("hasEnv returns true", hasEnv("SMOKE_KEY") === true);
assert("hasEnv returns false for missing", hasEnv("NONEXISTENT_KEY_XYZ") === false);

// ═══════════════════════════════════════════════════════════════════
// 20. WSDL
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 20. WSDL ===\n");

assert("WSDLService class exists", typeof WSDLService === "function");
assert("WSDLOp decorator exists", typeof WSDLOp === "function");

class TestCalc extends WSDLService {
  serviceName = "TestCalc";
  serviceUrl = "/api/calc";
}
const calc = new TestCalc();
assert("WSDLService subclass instantiates", calc.serviceName === "TestCalc");

// ═══════════════════════════════════════════════════════════════════
// 21. WebSocket
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 21. WebSocket ===\n");

// RFC 6455 test vector
const wsAccept = computeAcceptKey("dGhlIHNhbXBsZSBub25jZQ==");
assert("computeAcceptKey produces correct value", wsAccept === "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");

const wsPayload = Buffer.from("Hello", "utf-8");
const frame = buildFrame(OP_TEXT, wsPayload);
assert("buildFrame produces buffer", Buffer.isBuffer(frame));

const parsed = parseFrame(frame);
assert("parseFrame returns object", parsed !== null);
assert("parseFrame round-trip payload", parsed!.payload.toString("utf-8") === "Hello");

// ═══════════════════════════════════════════════════════════════════
// 22. Events
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 22. Events ===\n");

Events.clear();

let evtCalled = false;
Events.on("smoke.test", () => { evtCalled = true; });
Events.emit("smoke.test");
assert("on/emit works", evtCalled);

let onceCount = 0;
Events.once("smoke.once", () => { onceCount++; });
Events.emit("smoke.once");
Events.emit("smoke.once");
assert("once fires only once", onceCount === 1);

const fn = () => {};
Events.on("smoke.off", fn);
Events.off("smoke.off", fn);
assert("off removes listener", Events.listeners("smoke.off").length === 0);

Events.clear();

// ═══════════════════════════════════════════════════════════════════
// 23. Service Runner — cron matching
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 23. Service Runner ===\n");

assert("matchCronField * matches any", matchCronField("*", 30));
assert("matchCronField */5 matches 15", matchCronField("*/5", 15));
assert("matchCronField */5 rejects 3", !matchCronField("*/5", 3));
assert("matchCronField exact", matchCronField("10", 10));
assert("matchCronField list", matchCronField("1,5,10", 5));
assert("matchCronField range", matchCronField("1-5", 3));

// matchesCron for a specific date
const jan1 = new Date(2025, 0, 1, 9, 0); // Wed Jan 1 2025 09:00
assert("matchesCron full expression", matchesCron("0 9 1 1 *", jan1));
assert("matchesCron rejects mismatch", !matchesCron("30 10 * * *", jan1));

// ═══════════════════════════════════════════════════════════════════
// 24. Rate Limiter
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 24. Rate Limiter ===\n");

const rlMiddleware = rateLimiter({ maxRequests: 100, windowMs: 60000 });
assert("rateLimiter returns middleware function", typeof rlMiddleware === "function");

// ═══════════════════════════════════════════════════════════════════
// 25. Logger
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 25. Logger ===\n");

assert("Log.info exists", typeof Log.info === "function");
assert("Log.debug exists", typeof Log.debug === "function");
assert("Log.warning exists", typeof Log.warning === "function");
assert("Log.error exists", typeof Log.error === "function");
assert("Log.configure exists", typeof Log.configure === "function");

// ═══════════════════════════════════════════════════════════════════
// 26. API Client
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 26. API Client ===\n");

const api = new Api("https://httpbin.org");
assert("Api class instantiates", api !== null);
assert("Api.get method exists", typeof api.get === "function");
assert("Api.post method exists", typeof api.post === "function");
assert("Api.put method exists", typeof api.put === "function");
assert("Api.delete method exists", typeof api.delete === "function");

// ═══════════════════════════════════════════════════════════════════
// Cleanup and Summary
// ═══════════════════════════════════════════════════════════════════

try { rmSync(TMP, { recursive: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`  Smoke Test Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
