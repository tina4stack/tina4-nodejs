/**
 * @tina4/core docs — Live API RAG test corpus.
 *
 * Mirrors tina4-php/tests/DocsTest.php and tina4-python/tests/test_docs.py.
 * Same test names (translated to camelCase), same assertions, different
 * language. Implementation: packages/core/src/docs.ts.
 *
 * Spec: plan/v3/22-LIVE-API-RAG.md
 *
 * Run with: npx tsx test/docs.test.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { Docs } from "../packages/core/src/docs.ts";

// ── Fixture ────────────────────────────────────────────────────────

const fixtureRoot = path.join(os.tmpdir(), `tina4-docs-fixture-${crypto.randomBytes(4).toString("hex")}`);

function setupFixture(): void {
  fs.mkdirSync(path.join(fixtureRoot, "src", "orm"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "src", "routes"), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, "src", "templates"), { recursive: true });

  fs.writeFileSync(
    path.join(fixtureRoot, "src", "orm", "User.ts"),
    `/** User ORM model. */
export class User {
  static tableName = "users";
  static primaryKey = "id";

  /** Find a user by email — returns null if not found. */
  static async findByEmail(email: string): Promise<User | null> {
    return null;
  }

  /** Internal: hash a plaintext password. */
  private _hashPassword(plain: string): string {
    return plain;
  }
}
`,
    "utf-8",
  );

  fs.writeFileSync(
    path.join(fixtureRoot, "src", "routes", "contact.ts"),
    `import { post } from "@tina4/core";
import type { Tina4Request, Tina4Response } from "@tina4/core";

post("/contact", async (req: Tina4Request, res: Tina4Response) => {
  return res.json({ ok: true });
});
`,
    "utf-8",
  );

  fs.writeFileSync(
    path.join(fixtureRoot, "src", "templates", "home.twig"),
    `{% extends 'base.twig' %}
{% block content %}
  <h1>{{ title }}</h1>
{% endblock %}
`,
    "utf-8",
  );
}

function teardownFixture(): void {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch { /* ignore */ }
}

setupFixture();

// ── Test runner ────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failures: string[] = [];

function test(name: string, fn: () => void | Promise<void>): void {
  try {
    const out = fn();
    if (out instanceof Promise) {
      // Sync-only tests for predictable output ordering.
      throw new Error("docs tests must be synchronous");
    }
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n    ${msg}`);
    fail++;
    failures.push(name);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(a: T, b: T, msg: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(b)}\n    actual:   ${JSON.stringify(a)}`);
  }
}

function makeDocs(): Docs {
  return new Docs(fixtureRoot);
}

console.log("=== @tina4/core docs — Live API RAG tests ===\n");

// ── 1 ────────────────────────────────────────────────────────────────
test("test_search_finds_framework_render", () => {
  const docs = makeDocs();
  const hits = docs.search("render template", 5);
  assert(hits.length > 0, "search returned zero results");
  const top3 = hits.slice(0, 3);
  // For Node.js, framework class with `render` is `Frond` (in @tina4/frond, included in framework scan).
  const found = top3.some((h) => h.kind === "method" && h.name === "render" && h.source === "framework");
  assert(found, `a framework render method should rank in top 3; got ${JSON.stringify(top3.map((h) => h.fqn))}`);
});

// ── 2 ────────────────────────────────────────────────────────────────
test("test_search_finds_user_model", () => {
  const docs = makeDocs();
  const hits = docs.search("User", 5);
  const userHits = hits.filter((h) => h.source === "user");
  assert(userHits.length > 0, "expected at least one user-source hit for 'User'");
  const top3 = hits.slice(0, 3);
  const found = top3.some((h) => h.fqn.includes("User") && h.source === "user");
  assert(found, `user's User class should rank in top 3; got ${JSON.stringify(top3.map((h) => h.fqn))}`);
});

// ── 3 ────────────────────────────────────────────────────────────────
test("test_search_source_filter", () => {
  const docs = makeDocs();
  const fwOnly = docs.search("User", 10, "framework");
  for (const h of fwOnly) eq(h.source, "framework", "source=framework leaked a non-framework hit");
  const userOnly = docs.search("User", 10, "user");
  for (const h of userOnly) eq(h.source, "user", "source=user leaked a non-user hit");
});

// ── 4 ────────────────────────────────────────────────────────────────
test("test_class_endpoint_returns_full_method_list", () => {
  const docs = makeDocs();
  // Use a class that definitely has 5+ public methods in @tina4/core: Frond.
  const spec = docs.classSpec("Frond");
  assert(spec !== null, "Frond class should be reflectable from @tina4/frond");
  assert(Array.isArray(spec!.methods), "spec.methods must be an array");
  assert(spec!.methods.length >= 5, `Frond should have >=5 public methods; got ${spec!.methods.length}`);
  for (const m of spec!.methods) {
    assert("signature" in m, "method missing signature");
    assert("file" in m, "method missing file");
    assert("line" in m, "method missing line");
  }
});

// ── 5 ────────────────────────────────────────────────────────────────
test("test_class_endpoint_missing_class", () => {
  const docs = makeDocs();
  const spec = docs.classSpec("NotARealClass");
  assert(spec === null, "unknown class should return null (404 path on HTTP)");
});

// ── 6 ────────────────────────────────────────────────────────────────
test("test_method_endpoint_returns_signature", () => {
  const docs = makeDocs();
  const spec = docs.methodSpec("Frond", "render");
  assert(spec !== null, "Frond.render method should be reflectable");
  eq(spec!.name, "render", "method name should be render");
  assert(spec!.signature && spec!.signature.length > 0, "signature must be non-empty");
  eq(spec!.visibility, "public", "render must be public");
  eq(spec!.source, "framework", "render must be tagged framework");
});

// ── 7 ────────────────────────────────────────────────────────────────
test("test_user_class_appears_in_class_endpoint", () => {
  const docs = makeDocs();
  const spec = docs.classSpec("User");
  assert(spec !== null, "user model should be reflectable");
  eq(spec!.source, "user", "user model must be tagged user");
  const methodNames = spec!.methods.map((m) => m.name);
  assert(methodNames.includes("findByEmail"), `findByEmail should appear; got ${JSON.stringify(methodNames)}`);
});

// ── 8 ────────────────────────────────────────────────────────────────
test("test_index_endpoint_lists_all", () => {
  const docs = makeDocs();
  const idx = docs.index();
  assert(idx.length >= 50, `expected at least 50 entities; got ${idx.length}`);
  const sources = new Set(idx.map((e) => e.source));
  assert(sources.has("framework"), "no framework entries");
  assert(sources.has("user"), "no user entries");
});

// ── 9 ────────────────────────────────────────────────────────────────
test("test_mcp_docs_search_matches_http", () => {
  const docs = makeDocs();
  const direct = docs.search("render", 3);
  const viaMcp = Docs.mcpSearch("render", 3, fixtureRoot);
  eq(
    direct.map((h) => h.fqn),
    viaMcp.map((h) => h.fqn),
    "MCP and direct call must return the same ranked hits",
  );
});

// ── 10 ───────────────────────────────────────────────────────────────
test("test_mcp_docs_method_matches_http", () => {
  const docs = makeDocs();
  const direct = docs.methodSpec("Frond", "render");
  const viaMcp = Docs.mcpMethod("Frond", "render", fixtureRoot);
  eq(direct, viaMcp, "MCP and direct method spec must match");
});

// ── 11 ───────────────────────────────────────────────────────────────
test("test_index_refreshes_on_user_file_change", () => {
  const docs = makeDocs();
  const before = docs.methodSpec("User", "findActive");
  assert(before === null, "precondition: findActive does not exist yet");

  const userPath = path.join(fixtureRoot, "src", "orm", "User.ts");
  const src = fs.readFileSync(userPath, "utf-8");
  const patched = src.replace(
    "static primaryKey",
    `static async findActive(): Promise<User[]> { return []; }\n  static primaryKey`,
  );
  fs.writeFileSync(userPath, patched, "utf-8");
  const newMtime = (Date.now() + 2000) / 1000;
  fs.utimesSync(userPath, newMtime, newMtime);

  const after = docs.methodSpec("User", "findActive");
  assert(after !== null, "index should pick up newly-added method on next query");
});

// ── 12 ───────────────────────────────────────────────────────────────
test("test_drift_detector_finds_doc_inconsistency", () => {
  const tmp = path.join(fixtureRoot, "CLAUDE.md");
  fs.writeFileSync(
    tmp,
    "```ts\nresponse.fakeMethodThatDoesNotExist();\n```\n",
    "utf-8",
  );
  const report = Docs.checkDocs(tmp, fixtureRoot);
  assert(report.drift.length > 0, "drift detector should flag fakeMethodThatDoesNotExist");
  const found = report.drift.some((d) => d.method === "fakeMethodThatDoesNotExist");
  assert(found, `drift report should include fakeMethodThatDoesNotExist; got ${JSON.stringify(report.drift)}`);
});

// ── 13 ───────────────────────────────────────────────────────────────
test("test_sync_overwrites_marked_section", () => {
  const tmp = path.join(fixtureRoot, "CLAUDE.md");
  const original =
    "Prose above\n<!-- BEGIN GENERATED API -->\nold content\n<!-- END GENERATED API -->\nProse below\n";
  fs.writeFileSync(tmp, original, "utf-8");
  Docs.syncDocs(tmp, fixtureRoot);
  const updated = fs.readFileSync(tmp, "utf-8");
  assert(updated.includes("Prose above"), "prose above must be preserved");
  assert(updated.includes("Prose below"), "prose below must be preserved");
  assert(!updated.includes("old content"), "old generated content must be replaced");
  // Fresh content should mention some real framework class. Frond is the canonical "render" class.
  assert(/Frond|McpServer|Container|Events|Auth/.test(updated), "fresh content must include real classes");
});

// ── 14 ───────────────────────────────────────────────────────────────
test("test_search_response_under_50ms", () => {
  const docs = makeDocs();
  docs.search("warm-up", 1); // build the index once
  const start = process.hrtime.bigint();
  docs.search("render", 5);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  assert(elapsedMs < 50.0, `search took ${elapsedMs.toFixed(1)}ms (budget 50ms)`);
});

// ── 15 ───────────────────────────────────────────────────────────────
test("test_no_private_methods_in_default_search", () => {
  const docs = makeDocs();
  const hits = docs.search("hashPassword", 10);
  for (const h of hits) {
    assert(
      h.fqn !== "User._hashPassword",
      `private/internal methods must be excluded from default search; saw ${h.fqn}`,
    );
  }
  const optIn = docs.search("hashPassword", 10, "all", true);
  const fqns = optIn.map((h) => h.fqn);
  assert(
    fqns.includes("User._hashPassword"),
    `include_private=true must surface private methods; got ${JSON.stringify(fqns)}`,
  );
});

// ── 16 ───────────────────────────────────────────────────────────────
test("test_no_vendor_third_party_in_results", () => {
  const docs = makeDocs();
  const hits = docs.search("typescript", 20);
  for (const h of hits) {
    assert(h.source !== "vendor", `vendor results leaked into default search; saw ${h.fqn}`);
    assert(!h.file.includes("node_modules/typescript"), `node_modules path leaked: ${h.file}`);
    assert(!h.file.startsWith("node_modules/") || h.file.startsWith("node_modules/@tina4"),
      `non-tina4 node_modules path leaked: ${h.file}`);
  }
});

// ── 17 ───────────────────────────────────────────────────────────────
test("test_dynamic_methods_are_indexed", () => {
  // Frond's addFilter/addGlobal/addTest are public, documented API. In Node
  // they are normal class methods (static + instance), so the TS reflector
  // already indexes them — they must resolve via methodSpec with a usable
  // signature that leads with the method name.
  const docs = makeDocs();
  for (const name of ["addFilter", "addGlobal", "addTest"]) {
    const spec = docs.methodSpec("Frond", name);
    assert(spec !== null, `Frond.${name} must be indexed`);
    assert(
      spec!.signature.startsWith(`${name}(`),
      `signature should lead with the name; got ${JSON.stringify(spec!.signature)}`,
    );
  }
});

// ── 18 ───────────────────────────────────────────────────────────────
test("test_class_qualified_search_ranks_the_owning_method", () => {
  // A "Class.method" / "Class method" / bare "method" query must rank that
  // class's method first — the class qualifier has to steer ranking.
  const docs = makeDocs();
  for (const query of ["Frond.addTest", "Frond addTest", "addTest"]) {
    const hits = docs.search(query, 3);
    assert(hits.length > 0, `no hits for ${JSON.stringify(query)}`);
    eq(
      hits[0].fqn,
      "Frond.addTest",
      `${JSON.stringify(query)} should rank Frond.addTest #1; got ${JSON.stringify(hits.map((h) => h.fqn))}`,
    );
  }
});

// ── 19 ───────────────────────────────────────────────────────────────
test("test_lookup_resolves_public_import_path", () => {
  // The documented public import path (@tina4/orm.Database) must resolve even
  // though the index stores the bare class name (Database).
  const docs = makeDocs();
  const bare = "Database";
  const publicPath = "@tina4/orm.Database";
  assert(docs.classSpec(bare) !== null, "precondition: bare class name resolves");
  assert(docs.classSpec(publicPath) !== null, "public import path must resolve");
  assert(
    docs.methodSpec(publicPath, "execute") !== null,
    "methodSpec must resolve via the public import path",
  );
  // Both paths point at the same class.
  eq(docs.classSpec(publicPath)!.fqn, docs.classSpec(bare)!.fqn, "paths must resolve to the same class");
});

// ── 20 ───────────────────────────────────────────────────────────────
test("test_lookup_resolves_bare_class_name", () => {
  // A bare class name (Database) resolves to the one matching class; a truly
  // unknown name still returns null (no false positives).
  const docs = makeDocs();
  const spec = docs.classSpec("Database");
  assert(spec !== null, "bare class name must resolve");
  assert(spec!.fqn.endsWith("Database"), `fqn should end with Database; got ${spec!.fqn}`);
  assert(docs.methodSpec("Database", "execute") !== null, "method via bare name must resolve");
  // A truly unknown name still returns null.
  assert(docs.classSpec("DefinitelyNotAClass") === null, "unknown class must stay null");
  assert(docs.methodSpec("DefinitelyNotAClass", "execute") === null, "unknown method must stay null");
});

// ── Cleanup + summary ──────────────────────────────────────────────

teardownFixture();

console.log(`\n${"=".repeat(60)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
if (failures.length > 0) console.log(`  Failed: ${failures.join(", ")}`);
console.log(`${"=".repeat(60)}\n`);
process.exit(fail > 0 ? 1 : 0);
