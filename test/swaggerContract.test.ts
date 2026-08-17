/**
 * Swagger / OpenAPI CONTRACT suite — the ten invariants of
 * tina4-documentation/plan/v3/fixtures/swagger_contract.json (ADR-0004),
 * one `it()` per invariant. This is the tina4-nodejs half of the shared
 * contract; a sibling suite carries the same case names in each other
 * framework's idiom, and audit-contract-fixtures.py matches them by
 * NORMALISED name across all four, so each title carries its invariant id.
 *
 * NO MOCKS. The four server-backed invariants (document-validates,
 * every-template-has-a-parameter, security-mirrors-the-runtime-gate,
 * disabled-serves-nothing, only-the-application-is-documented) boot a REAL
 * Tina4 server as a detached `tsx` child, discover REAL file routes and a REAL
 * ORM model, and fetch the ACTUAL document over a REAL socket — the same
 * pattern requestBodyCap.test.ts / swaggerStaticGate.test.ts use, so route and
 * model discovery run under real tsx rather than the vitest loader. The
 * remaining invariants exercise the REAL generator directly (no server adds
 * anything to a pure spec-shape assertion, and no doubles are involved). The
 * document is validated with @apidevtools/swagger-parser — a TEST-ONLY
 * devDependency; the frameworks stay zero runtime-dependency.
 *
 * MEASURED 2026-08-06 (fixture): node shipped an INVALID document (unresolved
 * in:path parameters, unconditionally, because the framework registers
 * /__frond/live/{name} itself) and keyed model schemas by tableName. Fixed and
 * pinned here. The typed-path-token mapping (invariant path-param-types) needed
 * a generator fix in this change: generator.ts hardcoded schema {type:string}
 * for every path param and its name-only regex dropped a {id:int} token while
 * leaking `:int` into the key; it now mirrors the Python master's
 * _PARAM_TYPE_SCHEMA.
 *
 * Run: npx tsx test/run-all.ts   (the runner detects the `vitest` import and
 * drives this file with `vitest run`, so it is collected and self-executes).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import SwaggerParser from "@apidevtools/swagger-parser";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition } from "../packages/core/src/types.ts";
import type { ModelDefinition } from "../packages/orm/src/types.ts";
import { freePort } from "./freePort.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const TSX = resolve(REPO, "node_modules", ".bin", "tsx");
const FRAMEWORK_PUBLIC = resolve(REPO, "packages", "core", "public");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Real-server harness (no mocks) ────────────────────────────────────────────
const children: ChildProcess[] = [];
const dirs: string[] = [];

/** Scaffold an app with a public list, a secured write, a path-param read, a
 *  PUBLIC (noAuth) write, and a real ORM model whose CLASS name is `Item`. */
function scaffoldApp(): string {
  const root = mkdtempSync(join(tmpdir(), "t4-swagger-contract-"));
  dirs.push(root);
  const routes = join(root, "src", "routes");
  mkdirSync(join(routes, "api", "items", "[id]"), { recursive: true });
  mkdirSync(join(routes, "api", "public"), { recursive: true });
  mkdirSync(join(root, "src", "models"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"swagger-contract-app","type":"module","private":true}\n');

  const handler = "export default async function (_req: any, res: any) { return res.json({ ok: true }); }\n";
  writeFileSync(join(routes, "api", "items", "get.ts"), "export default async function (_req: any, res: any) { return res.json([]); }\n");
  // POST is a write — secure by default (the router's gate). No noAuth here.
  writeFileSync(join(routes, "api", "items", "post.ts"), handler);
  writeFileSync(join(routes, "api", "items", "[id]", "get.ts"), "export default async function (_req: any, res: any) { return res.json({}); }\n");
  // An explicitly PUBLIC write — the negative control for the security invariant.
  writeFileSync(join(routes, "api", "public", "post.ts"), "export const noAuth = true;\n" + handler);

  writeFileSync(
    join(root, "src", "models", "Item.ts"),
    "export default class Item {\n" +
      "  static tableName = 'items';\n" +
      "  static fields = {\n" +
      "    id: { type: 'integer', primaryKey: true, autoIncrement: true },\n" +
      "    name: { type: 'string', required: true, maxLength: 100 },\n" +
      "  };\n" +
      "}\n",
  );

  writeFileSync(
    join(root, "app.ts"),
    `import { startServer } from '${REPO}/packages/core/src/index.ts';\n` +
      `await startServer({ port: Number(process.env.PORT), basePath: '${root}' } as never);\n`,
  );
  return root;
}

/** Boot the scaffolded app as a detached tsx child and wait until it answers.
 *  `debug` additionally turns on TINA4_DEBUG — dev mode, which registers
 *  /__dev/* AND /__feedback/* (see feedback.ts's registerFeedbackRoutes,
 *  called unconditionally from DevAdmin.register) and exposes the real
 *  POST /__dev/api/reload hot-reload endpoint the boot-snapshot invariant
 *  drives. Off by default so the existing enabled/disabled invariants keep
 *  their pristine "no TINA4_DEBUG" premise. */
async function bootApp(swaggerEnabled: boolean, debug = false): Promise<{ base: string; root: string }> {
  const root = scaffoldApp();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const fd = openSync(join(root, "server.log"), "w");

  // Deterministic document: strip any leaked TINA4_SWAGGER_*/SWAGGER_* from the
  // child's inherited env, then set only the enable switch we are testing.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("TINA4_SWAGGER_") && !k.startsWith("SWAGGER_")) env[k] = v;
  }
  Object.assign(env, {
    PORT: String(port),
    TINA4_SWAGGER_ENABLED: swaggerEnabled ? "true" : "false",
    TINA4_DEBUG: debug ? "true" : "false",
    TINA4_NO_AI_PORT: "true",
    TINA4_NO_BROWSER: "true",
    TINA4_OVERRIDE_CLIENT: "true",
  });

  const child = spawn(TSX, ["app.ts"], { cwd: root, detached: true, stdio: ["ignore", fd, fd], env });
  children.push(child);
  closeSync(fd);

  // "Up" = a plain app route answers. GET /api/items is always served whether
  // or not swagger is enabled, so this waits without depending on the gate.
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/items`);
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 200) return { base, root };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`server never came up on ${base}:\n${readFileSync(join(root, "server.log"), "utf8").slice(-2000)}`);
}

async function statusOf(base: string, path: string, method = "GET", body?: string): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body } : {}),
  });
  await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

afterAll(async () => {
  for (const child of children) {
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
  await sleep(200);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Generator-only helpers ────────────────────────────────────────────────────
const route = (method: string, pattern: string, extra: Partial<RouteDefinition> = {}): RouteDefinition =>
  ({ method, pattern, handler: async () => {}, ...extra }) as RouteDefinition;

const model = (tableName: string, fields: ModelDefinition["fields"], className?: string): ModelDefinition =>
  ({ tableName, fields, ...(className ? { className } : {}) }) as ModelDefinition;

const itemFields: ModelDefinition["fields"] = {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  name: { type: "string", required: true, maxLength: 100 },
};

function pathParams(spec: any, path: string, verb: string): Array<{ name: string; in: string; required?: boolean; schema?: any }> {
  return ((spec.paths?.[path]?.[verb]?.parameters ?? []) as any[]).filter((p) => p.in === "path");
}

/** Every documented {template} that has no matching in:path parameter. Empty = valid. */
function unresolvedTemplates(spec: any): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries<any>(spec.paths ?? {})) {
    const want = [...path.matchAll(/\{(\.\.\.)?(\w+)\}/g)].map((m) => m[2]);
    for (const [verb, op] of Object.entries<any>(ops ?? {})) {
      if (!op || typeof op !== "object") continue;
      const declared = ((op.parameters ?? []) as any[]).filter((p) => p.in === "path").map((p) => p.name);
      for (const w of want) if (!declared.includes(w)) out.push(`${verb.toUpperCase()} ${path} -> {${w}}`);
    }
  }
  return out;
}

// The generator reads TINA4_SWAGGER_* lazily; clear them after every case so the
// defaults test cannot see a value the env-surface test set, in any order.
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("TINA4_SWAGGER_") || k.startsWith("SWAGGER_")) delete process.env[k];
  }
});

describe("swagger contract (ADR-0004)", () => {
  // One real enabled server, shared by the four server-backed invariants.
  let enabled: { base: string };
  let servedDoc: any;

  beforeAll(async () => {
    enabled = await bootApp(true);
    const res = await fetch(`${enabled.base}/swagger/openapi.json`);
    expect(res.status, "the enabled server did not serve /swagger/openapi.json").toBe(200);
    servedDoc = await res.json();
  }, 60_000);

  // 1 ─────────────────────────────────────────────────────────────────────────
  it("document validates: /swagger/openapi.json passes a real OpenAPI validator [the-document-validates]", async () => {
    // POSITIVE: the document a REAL server serves over a REAL socket — for an app
    // with routes, a path param, an ORM model and a secured route — passes a real
    // OpenAPI validator for the version it declares.
    expect(servedDoc.openapi).toBe("3.0.3");
    await expect(SwaggerParser.validate(structuredClone(servedDoc))).resolves.toBeDefined();

    // NEGATIVE (anti-ghost): the validator has teeth. A dangling $ref and an
    // invalid parameter `in` are each REJECTED, so a PASSED above is a real pass,
    // not a validator that accepts anything. (openapi-spec-validator's semantic
    // path-param check is gated separately below — swagger-parser dereferences +
    // schema-validates, which is what makes an invalid document invalid here.)
    const dangling = structuredClone(servedDoc);
    dangling.paths["/api/items"].post = {
      operationId: "x_dangling",
      responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/DoesNotExist" } } } } },
    };
    await expect(SwaggerParser.validate(dangling)).rejects.toThrow();

    const badIn = structuredClone(servedDoc);
    badIn.paths["/api/items/{id}"].get.parameters = [{ name: "id", in: "banana", required: true, schema: { type: "string" } }];
    await expect(SwaggerParser.validate(badIn)).rejects.toThrow();
  }, 30_000);

  // 2 ─────────────────────────────────────────────────────────────────────────
  it("every path template has a parameter in the served document [every-template-expression-has-a-parameter]", async () => {
    // The whole-document form of the rule, over the REAL served doc — this is
    // what failed: /__frond/live/{name} is registered by the framework, so an app
    // with zero user routes already published an unresolved parameter.
    expect(Object.keys(servedDoc.paths)).toContain("/__frond/live/{name}");
    expect(unresolvedTemplates(servedDoc), "template expressions with no in:path parameter").toEqual([]);

    const frond = pathParams(servedDoc, "/__frond/live/{name}", "get");
    expect(frond.map((p) => p.name)).toEqual(["name"]);
    expect(frond[0].required).toBe(true);

    // NEGATIVE: the detector actually detects — a hand-broken doc with a stripped
    // parameter is reported, so the empty result above is meaningful.
    const broken = structuredClone(servedDoc);
    delete broken.paths["/api/items/{id}"].get.parameters;
    expect(unresolvedTemplates(broken)).toContain("GET /api/items/{id} -> {id}");
  }, 30_000);

  // 3 ─────────────────────────────────────────────────────────────────────────
  it("security mirrors the runtime gate (secured 401 documented, public write is not) [security-mirrors-the-runtime-gate]", async () => {
    // POSITIVE: the server ANSWERS 401 for the secured write, and the document
    // says that operation requires auth. Same flag, not a parallel one.
    expect(await statusOf(enabled.base, "/api/items", "POST", "{}")).toBe(401);
    const securedOp = servedDoc.paths["/api/items"].post;
    expect(Array.isArray(securedOp.security)).toBe(true);
    expect(securedOp.security[0]?.bearerAuth).toBeDefined();
    expect(Object.keys(securedOp.responses)).toContain("401");

    // NEGATIVE: the explicitly-public write is NOT answered 401, and its document
    // carries no security requirement. A parallel flag would have documented it
    // as secured while the server let it through (Ruby's shipped bug).
    expect(await statusOf(enabled.base, "/api/public", "POST", "{}")).not.toBe(401);
    const publicOp = servedDoc.paths["/api/public"].post;
    expect(publicOp.security).toBeUndefined();

    // The public GET is public in both places too.
    expect(await statusOf(enabled.base, "/api/items", "GET")).toBe(200);
    expect(servedDoc.paths["/api/items"].get.security).toBeUndefined();
  }, 30_000);

  // 4 ─────────────────────────────────────────────────────────────────────────
  it("typed path token maps identically to its JSON Schema fragment [path-param-types-map-identically]", () => {
    // REAL generator over the token set the router (compilePattern) accepts. The
    // map mirrors the Python master's _PARAM_TYPE_SCHEMA.
    const spec: any = generate([
      route("GET", "/api/a/{id:int}"),
      route("GET", "/api/b/{id:integer}"),
      route("GET", "/api/c/{p:float}"),
      route("GET", "/api/d/{p:number}"),
      route("GET", "/api/e/{u:uuid}"),
      route("GET", "/api/f/{s:slug}"),
      route("GET", "/api/g/{a:alpha}"),
      route("GET", "/api/h/{a:alnum}"),
      route("GET", "/api/i/{id}"),
      route("GET", "/api/j/{z:mysterytype}"),
    ]);

    const schemaOf = (path: string) => pathParams(spec, path, "get")[0]?.schema;
    expect(schemaOf("/api/a/{id}")).toEqual({ type: "integer" });
    expect(schemaOf("/api/b/{id}")).toEqual({ type: "integer" });
    expect(schemaOf("/api/c/{p}")).toEqual({ type: "number" });
    expect(schemaOf("/api/d/{p}")).toEqual({ type: "number" });
    expect(schemaOf("/api/e/{u}")).toEqual({ type: "string", format: "uuid" });
    expect(schemaOf("/api/f/{s}")).toEqual({ type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
    expect(schemaOf("/api/g/{a}")).toEqual({ type: "string", pattern: "^[A-Za-z]+$" });
    expect(schemaOf("/api/h/{a}")).toEqual({ type: "string", pattern: "^[A-Za-z0-9]+$" });
    expect(schemaOf("/api/i/{id}")).toEqual({ type: "string" });

    // NEGATIVE: an unknown token degrades to string rather than DROPPING the
    // parameter (which would make the document invalid), and the token never
    // leaks into the path key.
    expect(Object.keys(spec.paths)).toContain("/api/j/{z}");
    expect(Object.keys(spec.paths).some((k) => k.includes(":"))).toBe(false);
    expect(schemaOf("/api/j/{z}")).toEqual({ type: "string" });
    expect(pathParams(spec, "/api/j/{z}", "get")).toHaveLength(1);
  });

  // 5 ─────────────────────────────────────────────────────────────────────────
  it("model schema keyed by class name, referenced by $ref [model-schemas-are-referenced-not-inlined]", () => {
    const spec: any = generate([route("POST", "/api/items")], [model("items", itemFields, "Item")]);

    // ONE entry, keyed by the CLASS name — never the tableName.
    expect(Object.keys(spec.components.schemas)).toEqual(["Item"]);
    expect(spec.components.schemas.items).toBeUndefined();

    // `required` derived from nullability (name is required, PK id is not).
    expect(spec.components.schemas.Item.required).toEqual(["name"]);

    // Referenced by $ref, not inlined; the $ref resolves.
    const ref = spec.paths["/api/items"].post.requestBody.content["application/json"].schema.$ref;
    expect(ref).toBe("#/components/schemas/Item");
    expect(spec.components.schemas[ref.split("/").pop()!]).toBeDefined();
  });

  // 6 ─────────────────────────────────────────────────────────────────────────
  it("info and servers defaults identical with no env set [info-and-servers-defaults-are-one-value]", () => {
    // afterEach has cleared every TINA4_SWAGGER_* — this is the true default.
    const spec: any = generate([], []);
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.info.version).not.toBe("0.0.1"); // the value Node used to emit
    expect(spec.info.description).toBe("");
    expect(spec.servers?.[0]?.url).toBe("/"); // correct under any port/host/proxy
    expect(spec.servers?.[0]?.url).not.toBe("http://localhost:7145");
  });

  // 7 ─────────────────────────────────────────────────────────────────────────
  it("swagger env surface identical: documented TINA4_SWAGGER_* vars are read [env-surface-is-identical]", () => {
    process.env.TINA4_SWAGGER_TITLE = "Contract API";
    process.env.TINA4_SWAGGER_VERSION = "4.2.0";
    process.env.TINA4_SWAGGER_DESCRIPTION = "described";
    process.env.TINA4_SWAGGER_CONTACT_EMAIL = "team@tina4.test";
    process.env.TINA4_SWAGGER_CONTACT_TEAM = "Tina4 Team"; // PHP ignored this one
    process.env.TINA4_SWAGGER_CONTACT_URL = "https://tina4.test"; // and this one
    process.env.TINA4_SWAGGER_LICENSE = "MIT|https://opensource.org/licenses/MIT";
    process.env.TINA4_SWAGGER_SERVERS = "https://a.test,https://b.test";
    process.env.TINA4_SWAGGER_OPENAPI = "3.1";
    process.env.TINA4_SWAGGER_BEARER_FORMAT = "opaque";
    process.env.TINA4_SWAGGER_API_KEY_NAME = "X-Api-Key";
    process.env.TINA4_SWAGGER_API_KEY_IN = "header";

    const spec: any = generate([], []);
    expect(spec.info.title).toBe("Contract API");
    expect(spec.info.version).toBe("4.2.0");
    expect(spec.info.description).toBe("described");
    expect(spec.info.contact).toEqual({ name: "Tina4 Team", url: "https://tina4.test", email: "team@tina4.test" });
    expect(spec.info.license).toEqual({ name: "MIT", url: "https://opensource.org/licenses/MIT" });
    expect(spec.servers).toEqual([{ url: "https://a.test" }, { url: "https://b.test" }]);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.components.securitySchemes.bearerAuth.bearerFormat).toBe("opaque");
    expect(spec.components.securitySchemes.apiKeyAuth).toEqual({ type: "apiKey", name: "X-Api-Key", in: "header" });

    // NEGATIVE: with CONTACT_TEAM/_URL unset, info.contact carries no name/url —
    // the exact drift PHP shipped (email only). afterEach clears them first.
    for (const k of ["TINA4_SWAGGER_CONTACT_TEAM", "TINA4_SWAGGER_CONTACT_URL"]) delete process.env[k];
    process.env.TINA4_SWAGGER_CONTACT_EMAIL = "team@tina4.test";
    const spec2: any = generate([], []);
    expect(spec2.info.contact).toEqual({ email: "team@tina4.test" });
    expect(spec2.info.contact.name).toBeUndefined();
    expect(spec2.info.contact.url).toBeUndefined();
  });

  // 8 ─────────────────────────────────────────────────────────────────────────
  it("disabled serves nothing: UI, spec and bundled assets all 404 [disabled-means-nothing-is-served]", async () => {
    // GUARD: the bundled UI assets really ship, so a 404 below means GATED, not
    // absent (a vacuous pass that would survive deleting the gate).
    expect(existsSync(join(FRAMEWORK_PUBLIC, "swagger", "index.html"))).toBe(true);
    expect(existsSync(join(FRAMEWORK_PUBLIC, "swagger", "oauth2-redirect.html"))).toBe(true);

    // POSITIVE control: on the ENABLED server every one of these serves.
    for (const p of ["/swagger", "/swagger/", "/swagger/openapi.json", "/swagger/index.html", "/swagger/oauth2-redirect.html"]) {
      expect(await statusOf(enabled.base, p), `enabled ${p}`).toBe(200);
    }

    // NEGATIVE: with TINA4_SWAGGER_ENABLED=false the UI path, its trailing-slash
    // form, the spec endpoint AND the bundled UI assets all 404 — on a REAL,
    // freshly-bound server.
    const disabled = await bootApp(false);
    for (const p of ["/swagger", "/swagger/", "/swagger/openapi.json", "/swagger/index.html", "/swagger/oauth2-redirect.html"]) {
      expect(await statusOf(disabled.base, p), `disabled ${p}`).toBe(404);
    }
    // ...and the server is up and serving the application, so those 404s are the
    // gate, not a dead process.
    expect(await statusOf(disabled.base, "/api/items", "GET")).toBe(200);
  }, 60_000);

  // 9 ─────────────────────────────────────────────────────────────────────────
  it("only the application is documented, framework surfaces excluded [only-the-application-is-documented]", async () => {
    const keys = Object.keys(servedDoc.paths);

    // POSITIVE: the application's own routes ARE documented.
    for (const p of ["/api/items", "/api/items/{id}", "/api/public"]) {
      expect(keys, `application route ${p} missing from the document`).toContain(p);
    }

    // NEGATIVE: the framework's documentation/admin surfaces are excluded by the
    // ONE shared rule (/swagger + /__dev), not a per-framework list — even though
    // /swagger/openapi.json is a REAL route the server answers 200 (so the
    // exclusion is active, not vacuous).
    expect(await statusOf(enabled.base, "/swagger/openapi.json")).toBe(200);
    expect(keys.filter((p) => p === "/swagger" || p.startsWith("/swagger/"))).toEqual([]);
    expect(keys.filter((p) => p === "/__dev" || p.startsWith("/__dev/"))).toEqual([]);
  }, 30_000);

  // 10 ────────────────────────────────────────────────────────────────────────
  it("operation ids stable and distinct across paths [operation-ids-are-stable-and-distinct]", () => {
    // /__health vs /health: leading underscores preserved, two distinct ids
    // straight from the two distinct paths — never a collapse-then-_2 suffix
    // whose winner depends on registration order.
    const spec: any = generate([route("GET", "/__health"), route("GET", "/health")]);
    const under = spec.paths["/__health"].get.operationId;
    const plain = spec.paths["/health"].get.operationId;
    expect(under).toBe("get___health");
    expect(plain).toBe("get_health");
    expect(under).not.toBe(plain);
    expect([under, plain]).not.toContain("get_health_2");

    // A genuine collision (two DIFFERENT paths reducing to one base) still gets a
    // numeric suffix — dropping that would be just as wrong.
    const dup: any = generate([route("GET", "/api/users/{id}"), route("GET", "/api/users/id")]);
    const a = dup.paths["/api/users/{id}"].get.operationId;
    const b = dup.paths["/api/users/id"].get.operationId;
    expect(a).not.toBe(b);
    expect([a, b].sort()).toEqual(["get_api_users_id", "get_api_users_id_2"]);

    // Distinct across the WHOLE served document too (real server, real routes).
    const ids = Object.values<any>(servedDoc.paths).flatMap((ops) => Object.values<any>(ops).map((op) => op.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  // 11 ────────────────────────────────────────────────────────────────────────
  it("spec reflects a route added after boot, past the boot-time snapshot [spec-reflects-a-route-added-after-boot]", async () => {
    // TINA4_DEBUG=true wires up the real POST /__dev/api/reload hot-reload
    // endpoint — the same mechanism the Rust CLI drives on a real file change.
    const debugApp = await bootApp(true, true);

    const before = await (await fetch(`${debugApp.base}/swagger/openapi.json`)).json();
    expect(before.paths).not.toHaveProperty("/late-added");
    expect(before.paths).toHaveProperty("/api/items");

    // Drop a NEW route file exactly as a developer editing the project would,
    // then fire the reload exactly as the Rust CLI does on a real fs change.
    const lateDir = join(debugApp.root, "src", "routes", "late-added");
    mkdirSync(lateDir, { recursive: true });
    writeFileSync(
      join(lateDir, "get.ts"),
      "export default async function (_req: any, res: any) { return res.json({ late: true }); }\n",
    );
    const reloadStatus = await statusOf(
      debugApp.base,
      "/__dev/api/reload",
      "POST",
      JSON.stringify({ file: "late-added/get.ts", type: "reload" }),
    );
    expect(reloadStatus, "the real reload endpoint must accept the trigger").toBe(200);

    // The served document must now reflect the route the reload just added —
    // proving the spec re-reads the LIVE route table, not a snapshot frozen
    // when the swagger routes were registered at boot.
    const after = await (await fetch(`${debugApp.base}/swagger/openapi.json`)).json();
    expect(after.paths, "a route added after boot must reach the document").toHaveProperty("/late-added");
    expect(after.paths).toHaveProperty("/api/items");
  }, 60_000);

  // 12 ────────────────────────────────────────────────────────────────────────
  it("internal feedback route is never in the spec, regardless of registration order [internal-feedback-route-is-never-in-the-spec]", async () => {
    // TINA4_DEBUG=true genuinely registers /__feedback/* into the SAME router
    // swagger reads (registerFeedbackRoutes, called unconditionally at the top
    // of DevAdmin.register) — the real production wiring, not a stand-in.
    const debugApp = await bootApp(true, true);

    // Guard: the endpoint is really live, so an absence below is the exclusion
    // RULE firing, not a vacuous "it was never registered" pass.
    expect(await statusOf(debugApp.base, "/__feedback/widget.js"), "/__feedback must be a real, live route").toBe(200);

    const doc = await (await fetch(`${debugApp.base}/swagger/openapi.json`)).json();
    const keys = Object.keys(doc.paths);
    expect(keys).not.toContain("/__feedback/widget.js");
    expect(keys).not.toContain("/__feedback/api/turn");
    expect(keys.filter((p) => p.startsWith("/__feedback"))).toEqual([]);

    // The exclusion is surgical — the application's own routes still document.
    expect(keys).toContain("/api/items");
  }, 60_000);

  // 13 ────────────────────────────────────────────────────────────────────────
  it("secured op per-op shape is identical: security + 401 + summary/tags converge [secured-op-per-op-shape-is-identical]", () => {
    const spec: any = generate([
      route("POST", "/contract/shape-item"),                     // secured by default, undecorated
      route("POST", "/contract/shape-public", { noAuth: true }), // explicitly public, undecorated
    ]);

    const secured = spec.paths["/contract/shape-item"].post;
    const expectedSecurity = spec.components?.securitySchemes?.ssoSession
      ? [{ bearerAuth: [] }, { ssoSession: [] }]
      : [{ bearerAuth: [] }];
    expect(secured.security).toEqual(expectedSecurity);
    expect(secured.responses["401"]).toEqual({ description: "Unauthorized" });
    expect(secured.summary).toBe("POST /contract/shape-item");
    expect(secured.tags).toEqual(["contract"]);
    expect(secured.description, "an undecorated operation must not fabricate a description").toBeUndefined();

    const publicOp = spec.paths["/contract/shape-public"].post;
    expect(publicOp.security, "an explicitly-public op documents no security").toBeUndefined();
    expect(publicOp.responses["401"], "an explicitly-public op documents no 401").toBeUndefined();
    expect(publicOp.summary, "summary populates regardless of security").toBe("POST /contract/shape-public");
    expect(publicOp.tags, "tags populate regardless of security").toEqual(["contract"]);
    expect(publicOp.description).toBeUndefined();
  });
});
