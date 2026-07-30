/**
 * Comprehensive smoke test for the Tina4 Node.js framework (v3).
 * Validates all key features work end-to-end using in-memory/temp resources.
 * Run with: npx tsx test/smoke.test.ts
 */
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ── Core imports ────────────────────────────────────────────────────
import {
  Router, cors, requestLogger,
  loadEnv, getEnv, hasEnv, resetEnv,
  Log,
  rateLimiter,
  getToken, validToken, hashPassword, checkPassword,
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
  WSDLService, WSDLOperation,
  AI_TOOLS, isInstalled, generateContext, installSelected,
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
import { generate } from "../packages/swagger/src/index.ts";
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
await syncModels([smokeModel]);

const adapter = getAdapter();
assert("smoke_users table created", (adapter as any).tableExists("smoke_users"));

// Validation
const vErrors = validate({}, SmokeUser.fields, false);
assert("validate rejects missing required fields", vErrors.length >= 2);

const vOk = validate({ name: "Alice", email: "alice@t.com" }, SmokeUser.fields, false);
assert("validate passes valid data", vOk.length === 0);

// BaseModel CRUD
const u = new SmokeUser({ name: "Alice", email: "alice@test.com" });
await u.save();
assert("BaseModel.save assigns id", (u as any).id !== undefined);

const found = await SmokeUser.findById((u as any).id);
assert("BaseModel.findById retrieves record", found !== null && (found as any).name === "Alice");

const all = await SmokeUser.all();
assert("BaseModel.all returns array", Array.isArray(all) && all.length === 1);

const dict = found!.toDict();
assert("toDict returns plain object", typeof dict === "object" && dict.name === "Alice");

closeDatabase();

// ═══════════════════════════════════════════════════════════════════
// 3. Database — URL parsing
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 3. Database ===\n");

// sqlite:///X is relative to cwd (matches Python/PHP convention).
// For absolute paths, use four slashes: sqlite:////X.
// See tina4-python plan/sqlite-url-relative-to-project-root.md.
const sqliteUrl = parseDatabaseUrl("sqlite:////tmp/test.db");
assert("parseDatabaseUrl sqlite engine", sqliteUrl.engine === "sqlite");
assert("parseDatabaseUrl sqlite database", sqliteUrl.database === "/tmp/test.db");

const pgUrl = parseDatabaseUrl("postgresql://admin:secret@db.example.com:5432/myapp");
assert("parseDatabaseUrl pg engine", pgUrl.engine === "postgres");
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
assert("session destroyed", sess.getSessionId() === null);

// ═══════════════════════════════════════════════════════════════════
// 7. Auth/JWT
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 7. Auth/JWT ===\n");

const SECRET = "smoke-test-secret-key";
process.env.TINA4_SECRET = SECRET;

const token = getToken({ userId: 1 }, 3600);
assert("getToken returns string", typeof token === "string");

assert("validToken returns true", validToken(token) !== null);

const expired = getToken({ userId: 1 }, -1);
assert("expired token rejected", validToken(expired) === null);

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
const q = new Queue({ topic: "emails", path: queueDir });

const jobId = q.push({ to: "bob@test.com", subject: "Hi" });
assert("push returns job id", typeof jobId === "string" && jobId.length > 0);

const job = q.pop();
assert("pop returns job", job !== null);
assert("job has correct payload", job !== null && (job.payload as any).to === "bob@test.com");

const emptyJob = q.pop();
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

const schema = gql.schemaSdl();
assert("schema contains type Product", schema.includes("type Product {"));
assert("schema contains Query type", schema.includes("type Query {"));
assert("schema contains Mutation type", schema.includes("type Mutation {"));

const qr = await gql.execute("{ products { id name } }");
assert("query executes and returns data", qr.data !== null);
assert("query returns products", Array.isArray((qr.data as any)?.products));

const mr = await gql.execute('mutation { createProduct(name: "Gadget") { name } }');
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

const spec = generate(routes, models);
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

const i18n = new I18n("en", localeDir);
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
const name1 = seeded1.name();
const name2 = seeded2.name();
assert("seeded data is deterministic", name1 === name2);

const fake = new FakeData();
assert("firstName returns string", typeof fake.firstName() === "string" && fake.firstName().length > 0);
assert("email contains @", fake.email().includes("@"));

// ═══════════════════════════════════════════════════════════════════
// 14. Migrations
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 14. Migrations ===\n");

await ensureMigrationTable();
const adapter2 = getAdapter();
assert("ensureMigrationTable creates table", (adapter2 as any).tableExists("tina4_migration"));
assert("isMigrationApplied returns false for new", !(await isMigrationApplied("nonexistent_migration")));

closeDatabase();

// ═══════════════════════════════════════════════════════════════════
// 15. Response Cache
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 15. Response Cache ===\n");

const cacheMw = responseCache({ ttl: 60 });
assert("responseCache returns middleware function", typeof cacheMw === "function");
await clearCache();
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

assert("AI_TOOLS is an array", Array.isArray(AI_TOOLS));
assert("AI_TOOLS has 7 entries", AI_TOOLS.length === 7);
const aiDir = join(TMP, "ai-test-empty");
mkdirSync(aiDir, { recursive: true });
assert("isInstalled false for empty dir", !isInstalled(aiDir, AI_TOOLS[0]));
const aiContext = generateContext();
assert("generateContext returns string", typeof aiContext === "string" && aiContext.includes("Tina4"));

// ═══════════════════════════════════════════════════════════════════
// 18. DevMailbox
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 18. DevMailbox ===\n");

const mbDir = join(TMP, "mailbox");
const mailbox = new DevMailbox(mbDir);

// Capture a real email to the temp dir and read the on-disk round-trip back.
const captureResult = mailbox.capture("bob@test.com", "Hi", "Body");
assert("DevMailbox captures email (success)", captureResult.success === true);
const inbox = mailbox.inbox();
assert(
  "DevMailbox inbox round-trip (subject + recipient)",
  inbox.length === 1 && inbox[0].subject === "Hi" && inbox[0].to.includes("bob@test.com"),
);
// Verify capture's filesystem effect: a JSON file landed and read() returns its body.
assert("DevMailbox.capture writes to disk (count)", mailbox.count("inbox").inbox === 1);
const fetched = mailbox.read(inbox[0].id);
assert("DevMailbox.read returns captured body", fetched !== null && fetched.body === "Body");

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

// Build a real WSDLService subclass with an actual operation, then exercise the
// real WSDL emitter and SOAP dispatcher instead of asserting the class exists.
class TestCalc extends WSDLService {
  serviceName = "TestCalc";
  serviceUrl = "/api/calc";

  async add(a: number, b: number): Promise<Record<string, unknown>> {
    return { result: a + b };
  }
}

// Apply the real WSDLOperation decorator function to add() exactly as the
// TypeScript decorator runtime would — (target, propertyKey, descriptor) — to
// prove it registers an operation (decorators are not enabled at runtime under
// tsx, so we invoke the exported decorator directly; this is the real code path,
// not a stub).
const addDescriptor = Object.getOwnPropertyDescriptor(TestCalc.prototype, "add")!;
WSDLOperation({ description: "Add two numbers", input: { a: "int", b: "int" }, output: { result: "int" } })(
  TestCalc.prototype,
  "add",
  addDescriptor,
);
assert("WSDLOperation registers _wsdlOp on the method", (TestCalc.prototype.add as any)._wsdlOp?.name === "add");

const calc = new TestCalc();

// Case 3/5: the real WSDL emitter produces a valid document driven by serviceName/serviceUrl.
const wsdl = calc.generateWSDL();
assert(
  "generateWSDL emits definitions + service binding for TestCalc",
  wsdl.includes('<definitions name="TestCalc"') && wsdl.includes("soap:address") && wsdl.includes('location="/api/calc"'),
);
assert(
  "generateWSDL emits namespace + portType derived from serviceName",
  wsdl.includes('targetNamespace="urn:TestCalc"') && wsdl.includes('name="TestCalcPortType"'),
);

// Case 4: the decorated operation appears in the WSDL and a real SOAP call computes 2+3=5.
assert("generateWSDL includes the add operation", wsdl.includes('<operation name="add">'));
const soapEnvelope =
  '<?xml version="1.0" encoding="UTF-8"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + "<soap:Body><add><a>2</a><b>3</b></add></soap:Body></soap:Envelope>";
const soapResult = await calc.handle(soapEnvelope);
assert("handle dispatches add and returns 5", soapResult.includes("<result>5</result>"));

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

// Exercise the real logger against a real file sink (TINA4_LOG_OUTPUT=file) and
// the real console-threshold predicate (Log.isEnabled). No mocks — the log file
// is a genuine sink we read back, and isEnabled is the production threshold fn.
const savedLogOut = process.env.TINA4_LOG_OUTPUT;
const savedLogFile = process.env.TINA4_LOG_FILE;
const savedLogLevel = process.env.TINA4_LOG_LEVEL;
const savedLogDebug = process.env.TINA4_DEBUG;
const savedLogFormat = process.env.TINA4_LOG_FORMAT;

const logFile = join(TMP, "logger", "tina4.log");
process.env.TINA4_LOG_OUTPUT = "file";       // file-only sink; keeps test stdout clean
process.env.TINA4_LOG_FILE = logFile;
delete process.env.TINA4_DEBUG;               // production format → structured JSON line

const readLog = (): string => (existsSync(logFile) ? readFileSync(logFile, "utf-8") : "");

// Case 11: Log.info emits a real INFO line containing the message; isEnabled reflects threshold.
process.env.TINA4_LOG_LEVEL = "INFO";
Log.info("hello world");
const afterInfo = readLog();
assert(
  "Log.info emits an INFO line with the message",
  afterInfo.includes("hello world") && afterInfo.includes("INFO"),
);
process.env.TINA4_LOG_LEVEL = "ERROR";
assert("Log.info suppressed at console when level=error (isEnabled false)", Log.isEnabled("info") === false);

// Case 12: Log.debug writes when level=debug; threshold logic gates it at info.
process.env.TINA4_LOG_LEVEL = "DEBUG";
Log.debug("dbg-line");
assert("Log.debug emits a line at level=debug", readLog().includes("dbg-line"));
process.env.TINA4_LOG_LEVEL = "INFO";
assert("Log.debug suppressed at console when level=info (isEnabled false)", Log.isEnabled("debug") === false);

// Case 13: Log.warning emits a WARNING line; suppressed at console when level=error.
process.env.TINA4_LOG_LEVEL = "WARNING";
Log.warning("careful");
const afterWarn = readLog();
assert(
  "Log.warning emits a WARNING line with the message",
  afterWarn.includes("careful") && afterWarn.includes("WARNING"),
);
process.env.TINA4_LOG_LEVEL = "ERROR";
assert("Log.warning suppressed at console when level=error (isEnabled false)", Log.isEnabled("warning") === false);

// Case 14: Log.error emits an ERROR line and always passes the threshold at level=error.
process.env.TINA4_LOG_LEVEL = "ERROR";
Log.error("boom");
const afterError = readLog();
assert(
  "Log.error emits an ERROR line with the message even at level=error",
  afterError.includes("boom") && afterError.includes("ERROR"),
);
assert("Log.error always passes threshold at level=error (isEnabled true)", Log.isEnabled("error") === true);

// Case 15: Log.configure changes the sink — point it at a fresh file and prove output lands there.
const configuredFile = join(TMP, "logger", "configured.log");
Log.configure({ logFile: configuredFile });
process.env.TINA4_LOG_LEVEL = "INFO";
Log.info("to-file");
assert(
  "Log.configure redirects output to the configured file",
  existsSync(configuredFile) && readFileSync(configuredFile, "utf-8").includes("to-file"),
);

// Restore env so later code / cleanup is unaffected.
if (savedLogOut === undefined) delete process.env.TINA4_LOG_OUTPUT; else process.env.TINA4_LOG_OUTPUT = savedLogOut;
if (savedLogFile === undefined) delete process.env.TINA4_LOG_FILE; else process.env.TINA4_LOG_FILE = savedLogFile;
if (savedLogLevel === undefined) delete process.env.TINA4_LOG_LEVEL; else process.env.TINA4_LOG_LEVEL = savedLogLevel;
if (savedLogDebug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = savedLogDebug;
if (savedLogFormat === undefined) delete process.env.TINA4_LOG_FORMAT; else process.env.TINA4_LOG_FORMAT = savedLogFormat;

// ═══════════════════════════════════════════════════════════════════
// 26. API Client
// ═══════════════════════════════════════════════════════════════════

console.log("\n=== 26. API Client ===\n");

// Drive real HTTP round-trips against a locally-served route table (no external
// network dependency, no mocks — a real node:http server on 127.0.0.1).
const itemStore: { value: { id: number; name: string } | null } = {
  value: { id: 1, name: "original" },
};
const apiServer = http.createServer((req, res) => {
  const url = req.url ?? "";
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && url === "/ping") return json(200, { pong: true });
    if (req.method === "GET" && url === "/status/200") return json(200, { ok: true });
    if (req.method === "GET" && url === "/item") {
      return itemStore.value ? json(200, itemStore.value) : json(404, { error: "gone" });
    }
    if (req.method === "POST" && url === "/echo") return json(200, JSON.parse(raw || "{}"));
    if (req.method === "PUT" && url === "/item") {
      itemStore.value = { id: 1, ...(JSON.parse(raw || "{}")) };
      return json(200, itemStore.value);
    }
    if (req.method === "DELETE" && url === "/item") {
      itemStore.value = null;
      res.writeHead(204);
      return res.end();
    }
    json(404, { error: "not found" });
  });
});
const apiPort: number = await new Promise((resolve) => {
  apiServer.listen(0, "127.0.0.1", () => resolve((apiServer.address() as AddressInfo).port));
});

const api = new Api(`http://127.0.0.1:${apiPort}`);

// Case 6: a real request against a live local endpoint.
const statusResult = await api.get("/status/200");
assert("Api.get hits live endpoint (200, no error)", statusResult.http_code === 200 && statusResult.error === null);

// Case 7: GET round-trip returning parsed JSON.
const pingResult = await api.get("/ping");
assert("Api.get returns parsed JSON body", pingResult.http_code === 200 && (pingResult.body as any).pong === true);

// Case 8: POST sends the body and the route echoes it back, parsed.
const echoResult = await api.post("/echo", { name: "Alice" });
assert("Api.post sends + parses JSON body", echoResult.http_code === 200 && (echoResult.body as any).name === "Alice");

// Case 9: PUT updates the resource; the echoed representation reflects the payload.
const putResult = await api.put("/item", { name: "updated" });
assert(
  "Api.put updates and returns the new representation",
  putResult.http_code === 200 && (putResult.body as any).name === "updated",
);

// Case 10: DELETE removes the resource; a follow-up GET is 404.
const delResult = await api.delete("/item");
const afterDelete = await api.get("/item");
assert(
  "Api.delete removes resource (204) then GET is 404",
  (delResult.http_code === 204 || delResult.http_code === 200) && afterDelete.http_code === 404,
);

await new Promise<void>((resolve) => apiServer.close(() => resolve()));

// ═══════════════════════════════════════════════════════════════════
// Cleanup and Summary
// ═══════════════════════════════════════════════════════════════════

try { rmSync(TMP, { recursive: true }); } catch {}

console.log(`\n${"=".repeat(60)}`);
console.log(`  Smoke Test Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(60)}\n`);

process.exit(failed > 0 ? 1 : 0);
