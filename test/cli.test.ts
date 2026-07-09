/**
 * Tests for CLI scaffolding (packages/cli/src/commands/generate.ts).
 *
 * Two tiers, both REAL (no mocks):
 *   • Helper + file-shape unit tests (fast, string-level).
 *   • Scaffolding-first acceptance matrix — generate into a REAL in-repo temp
 *     project, then: typecheck every generated file, boot the file-based routes
 *     through the REAL Router + TestClient + auth gate + SQLite (anon write→401,
 *     authed write→201, anon read→200), prove `--public` opens writes, prove no
 *     `secure:false` leaks onto writes by default, prove the auth routes stay
 *     public, and prove each logic stub THROWS when called + carries the AI-FILL
 *     banner + registers on the real Router / ServiceRunner / event bus.
 *
 * Run with: npx tsx test/cli.test.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import {
  toSnake, toTableName, toPascal, parseFields, parseCliArgs, parseEvery,
  aiFill, extend, generate,
} from "../packages/cli/src/commands/generate.ts";
import { Router, TestClient, getToken, discoverRoutes, Events, ServiceRunner } from "../packages/core/src/index.ts";
import { _resetRouteDiscovery } from "../packages/core/src/routeDiscovery.ts";
import { initDatabase, FakeData } from "../packages/orm/src/index.ts";

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

async function expectThrows(fn: () => unknown | Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

/** Capture console.log emitted while `fn` runs (for "File already exists" checks). */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let buf = "";
  console.log = (...a: unknown[]) => { buf += a.map(String).join(" ") + "\n"; };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return buf;
}

console.log("=== CLI Scaffolding Tests ===\n");

// ── toSnake ─────────────────────────────────────────────────────────
console.log("--- toSnake ---");
assert("simple lowercase", toSnake("product") === "product");
assert("CamelCase", toSnake("ProductCategory") === "product_category");
assert("camelCase", toSnake("productCategory") === "product_category");
assert("consecutive uppercase", toSnake("HTMLParser") === "html_parser");
assert("single letter", toSnake("A") === "a");
assert("already_snake", toSnake("already_snake") === "already_snake");
assert("numbers preserved", toSnake("Item2") === "item2");

// ── toTableName ─────────────────────────────────────────────────────
console.log("\n--- toTableName ---");
assert("CamelCase to snake", toTableName("ProductCategory") === "product_category");
assert("simple name", toTableName("User") === "user");
assert("already lower", toTableName("orders") === "orders");

// ── toPascal ────────────────────────────────────────────────────────
console.log("\n--- toPascal ---");
assert("slug to Pascal", toPascal("order-emails") === "OrderEmails");
assert("dotted to Pascal", toPascal("user.created") === "UserCreated");
assert("already Pascal", toPascal("Product") === "Product");

// ── parseFields ─────────────────────────────────────────────────────
console.log("\n--- parseFields ---");
{
  const fields = parseFields("name:string,price:float,active:boolean");
  assert("parses 3 fields", fields.length === 3);
  assert("first field name", fields[0][0] === "name" && fields[0][1] === "string");
  assert("second field name", fields[1][0] === "price" && fields[1][1] === "float");
  assert("third field name", fields[2][0] === "active" && fields[2][1] === "boolean");
}
{
  const fields = parseFields("title,description");
  assert("fields without type default to string", fields[0][1] === "string" && fields[0][0] === "title");
  assert("second field without type", fields[1][0] === "description");
}
{
  const fields = parseFields("");
  assert("empty string returns empty array", fields.length === 0);
}
{
  const fields = parseFields("  name : string , age : int  ");
  assert("trims whitespace", fields[0][0] === "name" && fields[0][1] === "string");
  assert("trims second field", fields[1][0] === "age" && fields[1][1] === "int");
}
{
  const fields = parseFields(":::,,,bad");
  assert("malformed --fields does not throw and drops empty names", fields.length === 1 && fields[0][0] === "bad");
}

// ── parseCliArgs ────────────────────────────────────────────────────
console.log("\n--- parseCliArgs ---");
{
  const { flags, positional } = parseCliArgs(["model", "Product", "--fields", "name:string"]);
  assert("positional has model and Product", positional[0] === "model" && positional[1] === "Product");
  assert("flags has fields", flags.fields === "name:string");
}
{
  const { flags } = parseCliArgs(["route", "products", "--model", "Product", "--public"]);
  assert("public is a boolean flag", flags.public === true);
  assert("model flag still parses with a following boolean flag", flags.model === "Product");
}
{
  const { flags } = parseCliArgs(["model", "Product", "--no-migration"]);
  assert("no-migration is a boolean flag", flags["no-migration"] === true);
}

// ── parseEvery ──────────────────────────────────────────────────────
console.log("\n--- parseEvery ---");
assert("5m -> 300", parseEvery("5m") === 300);
assert("30s -> 30", parseEvery("30s") === 30);
assert("2h -> 7200", parseEvery("2h") === 7200);
assert("1d -> 86400", parseEvery("1d") === 86400);
assert("bare 45 -> 45", parseEvery("45") === 45);
assert("empty -> 60 default", parseEvery("") === 60);
assert("garbage -> 60 default", parseEvery("garbage") === 60);
assert("true (bare flag) -> 60 default", parseEvery(true) === 60);

// ── aiFill / extend ─────────────────────────────────────────────────
console.log("\n--- aiFill / extend ---");
{
  const block = aiFill("createWidget", {
    intent: "persist a widget",
    given: "req.body -> fields",
    use: "new Model(req.body).save()",
    ret: "res.json({ data }, 201)",
    ground: 'tina4_context("create ORM record", "nodejs")',
    raise: "create widget not implemented",
  });
  assert("aiFill has AI-FILL banner", block.includes("AI-FILL: createWidget"));
  assert("aiFill has Intent/Use/Ground", block.includes("// Intent:") && block.includes("// Use:") && block.includes("// Ground:"));
  assert("aiFill throws not-implemented", block.includes('throw new Error("create widget not implemented")'));
}
{
  const block = extend("validate before persist", "e.g. reject invalid input");
  assert("extend marks the point", block.includes("EXTEND: validate before persist"));
  assert("extend has NO throw", !block.includes("throw new Error"));
}

// ══════════════════════════════════════════════════════════════════════
// Scaffolding-first acceptance matrix — REAL in-repo temp project.
// The project MUST live inside the repo tree so the generated files'
// `import … from "tina4-nodejs"[/orm]` self-resolve via the package exports
// map (they do not resolve from an arbitrary /tmp dir).
// ══════════════════════════════════════════════════════════════════════

const repoRoot = process.cwd();
const tmpDir = resolve(repoRoot, `.tmp_cli_test_${process.pid}`);
const tmpBase = `.tmp_cli_test_${process.pid}`;

async function main(): Promise<void> {
  console.log("\n--- Generate a full sample project (in-repo temp) ---");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  process.chdir(tmpDir);
  try {
    await generate("model", "Sprocket", ["--fields", "name:string,qty:int", "--no-migration"]);
    await generate("model", "Widget", ["--fields", "name:string", "--no-migration"]);
    await generate("route", "sprockets", ["--model", "Sprocket"]);          // secure by default
    await generate("route", "widgets", ["--model", "Widget", "--public"]);  // --public opens writes
    await generate("route", "notes", []);                                   // no model → AI-FILL stubs
    await generate("crud", "Gadget", ["--fields", "name:string,qty:int"]);  // full stack + gate test
    await generate("auth", "", []);
    await generate("service", "Reaper", ["--every", "5m"]);
    await generate("service", "Nightly", ["--cron", "0 3 * * *"]);
    await generate("queue", "order-emails", []);
    await generate("validator", "CreateUser", []);
    await generate("seeder", "Sprocket", []);
    await generate("websocket", "chat", []);
    await generate("listener", "user.created", []);
  } finally {
    process.chdir(repoRoot);
  }

  const read = (rel: string) => readFileSync(join(tmpDir, rel), "utf-8");
  const importGen = (rel: string) => import(pathToFileURL(join(tmpDir, rel)).href);

  // ── B1: every generated file typechecks ──────────────────────────
  console.log("\n--- B1: generated files typecheck (tsc --noEmit) ---");
  writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["ES2022"], module: "ESNext", moduleResolution: "Bundler",
      types: ["node"], strict: true, esModuleInterop: true, skipLibCheck: true,
      resolveJsonModule: true, noEmit: true, baseUrl: ".",
      paths: {
        "tina4-nodejs": ["../packages/core/src/index.ts"],
        "tina4-nodejs/orm": ["../packages/orm/src/index.ts"],
      },
    },
    include: ["src/**/*.ts", "tests/**/*.ts"],
  }, null, 2));
  let tscOut = "";
  try {
    tscOut = execSync(`npx tsc --noEmit -p ${JSON.stringify(join(tmpDir, "tsconfig.json"))}`,
      { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    tscOut = (e.stdout ?? "") + (e.stderr ?? "");
  }
  // Isolate errors located in the GENERATED tree (ignore pre-existing framework
  // errors dragged in transitively via the tina4-nodejs/orm path mapping).
  const genErrors = tscOut.split("\n").filter((l) => l.includes(tmpBase) && l.includes("error TS"));
  assert("B1: every generated file typechecks (0 errors in generated tree)",
    genErrors.length === 0, `\n${genErrors.join("\n")}`);

  // ── DB + real router from the generated file-based routes ─────────
  process.env.TINA4_SECRET = "scaffold-test-secret";
  delete process.env.TINA4_API_KEY;
  mkdirSync(join(tmpDir, "data"), { recursive: true });
  await initDatabase({ url: `sqlite:///${tmpDir}/data/scaffold.db` });

  const Sprocket = (await importGen("src/models/Sprocket.ts")).default;
  const Widget = (await importGen("src/models/Widget.ts")).default;
  const Gadget = (await importGen("src/models/Gadget.ts")).default;
  const User = (await importGen("src/models/User.ts")).default;
  await Sprocket.createTable();
  await Widget.createTable();
  await Gadget.createTable();
  await User.createTable();

  assert("model imports BaseModel from tina4-nodejs/orm (not core)",
    read("src/models/Sprocket.ts").includes('from "tina4-nodejs/orm"'));

  _resetRouteDiscovery();
  const router = new Router();
  const defs = await discoverRoutes(join(tmpDir, "src/routes"));
  for (const def of defs) router.addRoute(def);
  const client = new TestClient(router);

  // ── B2: secure-by-default model route (anon read 200 / anon write 401 / authed 201) ──
  console.log("\n--- B2: model route secure-by-default boot-gate ---");
  assert("R1: five routes registered for sprockets",
    ["GET /api/sprockets", "POST /api/sprockets", "GET /api/sprockets/{id}",
     "PUT /api/sprockets/{id}", "DELETE /api/sprockets/{id}"]
      .every((sig) => defs.some((d) => `${d.method} ${d.pattern}` === sig)));
  assert("R2a: anon GET /api/sprockets -> 200 (read public)",
    (await client.get("/api/sprockets")).status === 200);
  assert("R2b: anon GET /api/sprockets/1 -> 200|404 (read public)",
    [200, 404].includes((await client.get("/api/sprockets/1")).status));
  assert("R2c: anon POST /api/sprockets -> 401 (write gated)",
    (await client.post("/api/sprockets", { json: { name: "a", qty: 1 } })).status === 401);
  const token = getToken({ userId: 1 });
  const created = await client.post("/api/sprockets",
    { json: { name: "a", qty: 2 }, headers: { authorization: `Bearer ${token}` } });
  assert("R2d: authed POST /api/sprockets -> 201 (token passes the gate + persists)",
    created.status === 201, String(created.status));
  assert("R2e: authed create really persisted (id + fields in body)",
    (() => { const b = created.json() as { data?: { id?: number; name?: string } }; return b?.data?.id !== undefined && b?.data?.name === "a"; })());

  // ── B3: --public opens the writes ─────────────────────────────────
  console.log("\n--- B3: --public opens writes ---");
  assert("R3a: anon POST /api/widgets -> 201 (--public opened it)",
    (await client.post("/api/widgets", { json: { name: "w" } })).status === 201);
  assert("R3b: router resolves widgets POST as secure:false", router.match("POST", "/api/widgets")?.secure === false);
  assert("R3c: router resolves widgets PUT as secure:false", router.match("PUT", "/api/widgets/1")?.secure === false);
  assert("R3d: router resolves widgets DELETE as secure:false", router.match("DELETE", "/api/widgets/1")?.secure === false);
  assert("R3e: widgets GET is NOT flipped to secure:false (reads already public)",
    router.match("GET", "/api/widgets")?.secure !== false);

  // ── B4: source posture — no secure:false on writes by default; only on writes when public ──
  console.log("\n--- B4: secure:false only on public writes ---");
  const sprocketPost = read("src/routes/api/sprockets/post.ts");
  const sprocketGet = read("src/routes/api/sprockets/get.ts");
  assert("R4a: default write file has NO secure:false", !sprocketPost.includes("secure = false"));
  assert("R4b: default read file has NO secure:false", !sprocketGet.includes("secure = false"));
  assert("R4c: default model route uses working CRUD (EXTEND marker, no throw)",
    sprocketPost.includes("EXTEND:") && !sprocketPost.includes("throw new Error"));
  const widgetPost = read("src/routes/api/widgets/post.ts");
  const widgetPut = read("src/routes/api/widgets/[id]/put.ts");
  const widgetDelete = read("src/routes/api/widgets/[id]/delete.ts");
  const widgetGet = read("src/routes/api/widgets/get.ts");
  const widgetGetId = read("src/routes/api/widgets/[id]/get.ts");
  assert("R4d: --public emits secure:false on POST/PUT/DELETE only",
    widgetPost.includes("export const secure = false;") &&
    widgetPut.includes("export const secure = false;") &&
    widgetDelete.includes("export const secure = false;"));
  assert("R4e: --public NEVER emits secure:false on GET files",
    !widgetGet.includes("secure = false") && !widgetGetId.includes("secure = false"));
  assert("R4f: router resolves sprockets writes as secure:true (gated)",
    router.match("POST", "/api/sprockets")?.secure === true &&
    router.match("PUT", "/api/sprockets/1")?.secure === true &&
    router.match("DELETE", "/api/sprockets/1")?.secure === true);

  // ── B5: no-model route is a LIVE AI-FILL stub ─────────────────────
  console.log("\n--- B5: no-model route AI-FILL stub ---");
  const notesGet = read("src/routes/api/notes/get.ts");
  const notesPost = read("src/routes/api/notes/post.ts");
  assert("S2a: no-model route has AI-FILL banner + Ground line",
    notesGet.includes("AI-FILL") && notesGet.includes("// Ground:"));
  assert("S1a: no-model route body throws not-implemented",
    notesGet.includes("throw new Error(") && notesPost.includes("throw new Error("));
  assert("R4g: no-model route has NO secure:false by default (write still gated)",
    !notesPost.includes("secure = false"));
  assert("S1b: calling the no-model list handler throws",
    await expectThrows(() => (importGen("src/routes/api/notes/get.ts")).then((m) => m.default({} as never, {} as never))));
  assert("S3a: the no-model write is gated (401) even though the handler is a stub",
    (await client.post("/api/notes", { json: {} })).status === 401);

  // ── B6: emitted CRUD gate test — created, correct symbols, secure posture ──
  console.log("\n--- B6: CRUD stack ---");
  assert("crud: model + routes + form + view + gate test all created",
    existsSync(join(tmpDir, "src/models/Gadget.ts")) &&
    existsSync(join(tmpDir, "src/routes/api/gadgets/get.ts")) &&
    existsSync(join(tmpDir, "src/templates/forms/gadget.twig")) &&
    existsSync(join(tmpDir, "tests/gadgets.test.ts")));
  const gadgetsPost = read("src/routes/api/gadgets/post.ts");
  assert("crud: default routes are secure (no secure:false on writes)", !gadgetsPost.includes("secure = false"));
  const gadgetTest = read("tests/gadgets.test.ts");
  assert("crud: emitted gate test is a REAL TestClient boot (no mocks)",
    gadgetTest.includes("TestClient") && gadgetTest.includes("discoverRoutes") && gadgetTest.includes("initDatabase"));
  assert("crud: emitted gate test asserts anon 401 + authed 201 + read 200",
    gadgetTest.includes("-> 401") && gadgetTest.includes("-> 201") && gadgetTest.includes("-> 200"));
  // Run the emitted gate test for real (in-repo → tina4-nodejs self-resolves).
  let gadgetTestGreen = false;
  try {
    const out = execSync(`npx tsx ${JSON.stringify(join(tmpDir, "tests/gadgets.test.ts"))}`,
      { cwd: tmpDir, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    gadgetTestGreen = /(\d+) passed, 0 failed/.test(out);
  } catch { gadgetTestGreen = false; }
  assert("R5: the emitted CRUD gate test runs GREEN in a real subprocess", gadgetTestGreen);

  // ── A1: auth routes stay PUBLIC (fix must not over-sweep) ─────────
  console.log("\n--- A1: auth login/register stay public ---");
  const registerPost = read("src/routes/api/auth/register/post.ts");
  const loginPost = read("src/routes/api/auth/login/post.ts");
  assert("A1a: register + login opt out of the gate (public)",
    registerPost.includes("export const secure = false;") && loginPost.includes("export const secure = false;"));
  assert("A1b: router resolves register POST as public (secure:false)",
    router.match("POST", "/api/auth/register")?.secure === false);
  assert("A1c: router resolves login POST as public (secure:false)",
    router.match("POST", "/api/auth/login")?.secure === false);
  assert("A1d: anon POST /api/auth/register is NOT 401 (public gate open)",
    (await client.post("/api/auth/register", { json: { email: "x@y.z", password: "secret12" } })).status !== 401);
  assert("A1e: auth register hashes the password (never stores plaintext)",
    registerPost.includes("hashPassword"));

  // ── The six logic-shaped generators (B1 typecheck already covered) ──
  console.log("\n--- Six logic-shaped generators (real wiring) ---");

  // service (interval)
  {
    const src = read("src/services/reaper.ts");
    assert("service: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    const mod = await importGen("src/services/reaper.ts");
    assert("service: task throws until filled", await expectThrows(() => mod.reaperTask({} as never)));
    assert("service: default export has name + interval for ServiceRunner.discover",
      mod.default.name === "reaper" && mod.default.interval === 300);
  }
  // service (cron)
  {
    const mod = await importGen("src/services/nightly.ts");
    assert("service --cron: default export carries the cron timing", mod.default.timing === "0 3 * * *");
  }
  // service registers on the REAL ServiceRunner
  {
    const infos = await ServiceRunner.discover(join(tmpDir, "src/services"));
    const names = infos.map((i) => i.name);
    assert("service: registers on the REAL ServiceRunner (reaper discovered w/ interval)",
      names.includes("reaper") && infos.find((i) => i.name === "reaper")?.options.interval === 300);
    assert("queue: consumer registered as a daemon on the REAL ServiceRunner",
      names.includes("order-emails-consumer") &&
      infos.find((i) => i.name === "order-emails-consumer")?.options.daemon === true);
    ServiceRunner.remove("reaper");
    ServiceRunner.remove("nightly");
    ServiceRunner.remove("order-emails-consumer");
  }
  // queue
  {
    const src = read("src/services/order_emails_consumer.ts");
    assert("queue: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    const mod = await importGen("src/services/order_emails_consumer.ts");
    assert("queue: handler throws until filled", await expectThrows(() => mod.handleOrderEmails({})));
    const id = mod.publishOrderEmails({ to: "a@b.c" }); // real file-backend produce
    assert("queue: producer pushes a real job and returns an id", typeof id === "string" && id.length > 0);
    assert("queue: consumer default export is a daemon", mod.default.daemon === true);
  }
  // validator
  {
    const src = read("src/validators/create_user.ts");
    assert("validator: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    assert("validator: imports the real Validator", src.includes('import { Validator } from "tina4-nodejs"'));
    const mod = await importGen("src/validators/create_user.ts");
    assert("validator: throws until filled", await expectThrows(() => mod.validateCreateUser({})));
  }
  // seeder
  {
    const src = read("src/seeds/sprocket_seeder.ts");
    assert("seeder: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    assert("seeder: wires seedOrm + the model (run() for `tina4nodejs seed`)",
      src.includes("seedOrm") && src.includes("function run"));
    const mod = await importGen("src/seeds/sprocket_seeder.ts"); // import must NOT seed (main-guard)
    assert("seeder: fieldOverrides throws until filled", await expectThrows(() => mod.fieldOverrides(new FakeData())));
  }
  // websocket
  {
    const src = read("src/routes/ws_chat.ts");
    assert("websocket: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    const { defaultRouter } = await import("../packages/core/src/router.ts");
    const mod = await importGen("src/routes/ws_chat.ts"); // import registers via websocket()
    assert("websocket: registered on the REAL router",
      defaultRouter.getWebSocketRoutes().some((r) => r.pattern === "/ws/chat"));
    assert("websocket: message handler throws until filled",
      await expectThrows(() => mod.chatWs(null as never, "message", "hi")));
  }
  // listener
  {
    const src = read("src/listeners/user_created.ts");
    assert("listener: AI-FILL banner + Ground", src.includes("AI-FILL") && src.includes("// Ground:"));
    const mod = await importGen("src/listeners/user_created.ts"); // import registers via Events.on()
    assert("listener: bound on the REAL event bus", Events.listeners("user.created").length >= 1);
    assert("listener: reaction throws until filled", await expectThrows(() => mod.onUserCreated({ id: 1 })));
  }

  // ── Idempotency: a second generate refuses to clobber ─────────────
  console.log("\n--- Idempotency (never clobber an existing file) ---");
  process.chdir(tmpDir);
  try {
    const before = read("src/validators/create_user.ts");
    const out = await captureLog(() => generate("validator", "CreateUser", []));
    assert("idempotent: second generate prints 'File already exists'", out.includes("already exists"));
    assert("idempotent: original file is untouched", read("src/validators/create_user.ts") === before);
  } finally {
    process.chdir(repoRoot);
  }
}

try {
  await main();
} catch (err) {
  assert("scaffolding matrix ran without an unexpected throw", false, String(err));
} finally {
  process.chdir(repoRoot);
  rmSync(tmpDir, { recursive: true, force: true });
}

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
