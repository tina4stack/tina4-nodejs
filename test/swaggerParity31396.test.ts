/**
 * Swagger parity fixes for 3.13.96 — S2, S3, S5, S6.
 *
 * Every invariant here was MEASURED 2026-08-06 across the four frameworks and
 * settled in tina4-documentation/plan/v3/parity-3.13.96-decisions.md. Node was
 * the outlier on all four; each test moves Node to the Python reference and
 * carries a NEGATIVE case that fails against the pre-3.13.96 behaviour, so the
 * red proves the divergence was reproduced rather than imagined.
 *
 * No mocks: the REAL generator over route shapes that ROUTE DISCOVERY produces
 * ({id}/{...slug} URL patterns, not the [id] file-system spelling the older
 * swagger.test.ts hand-fed), and real ModelDefinition objects.
 */
import { describe, it, expect, afterEach } from "vitest";
import { generate } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition } from "../packages/core/src/types.ts";
import type { ModelDefinition } from "../packages/orm/src/types.ts";

const route = (method: string, pattern: string, extra: Partial<RouteDefinition> = {}): RouteDefinition =>
  ({ method, pattern, handler: async () => {}, ...extra }) as RouteDefinition;

// A real ORM model definition. `className` is what discoverModels() now carries
// from the model CLASS (ModelClass.name); a raw definition without it falls back
// to a singular-PascalCase derivation of tableName.
const model = (tableName: string, fields: ModelDefinition["fields"], className?: string): ModelDefinition =>
  ({ tableName, fields, ...(className ? { className } as object : {}) }) as ModelDefinition;

const itemFields: ModelDefinition["fields"] = {
  id: { type: "integer", primaryKey: true, autoIncrement: true },
  name: { type: "string", required: true, maxLength: 100 },
};

function responseKeys(spec: any, path: string, verb: string): string[] {
  return Object.keys((spec.paths?.[path]?.[verb] as any)?.responses ?? {}).sort();
}

afterEach(() => {
  delete process.env.TINA4_SWAGGER_VERSION;
  delete process.env.TINA4_SWAGGER_DESCRIPTION;
  delete process.env.TINA4_SWAGGER_SERVERS;
});

// ── S2. components.schemas keyed by the model CLASS name ──────────────────────
describe("S2 — components.schemas keyed by class name, not tableName", () => {
  it("keys the schema by the class name ('Item'), never the tableName ('items')", () => {
    const spec: any = generate([], [model("items", itemFields, "Item")]);
    expect(Object.keys(spec.components.schemas)).toEqual(["Item"]);
    // NEGATIVE: the tableName key is the pre-3.13.96 bug — it must be gone.
    expect(spec.components.schemas.items).toBeUndefined();
  });

  it("the POST request body $ref points at the class-name schema", () => {
    const spec: any = generate(
      [route("POST", "/api/items")],
      [model("items", itemFields, "Item")],
    );
    const body = (spec.paths["/api/items"].post as any).requestBody;
    const ref = body.content["application/json"].schema.$ref;
    expect(ref).toBe("#/components/schemas/Item");
    // NEGATIVE: the tableName-keyed $ref would dangle (no such schema).
    expect(ref).not.toBe("#/components/schemas/items");
    expect(spec.components.schemas[ref.split("/").pop()]).toBeDefined();
  });

  it("derives a singular PascalCase class name when a raw definition carries none", () => {
    // A caller that hands generate() a bare {tableName, fields} still gets a
    // client-friendly type name. 'items' -> 'Item', not 'Items' and not 'items'.
    const spec: any = generate([], [model("items", itemFields)]);
    expect(Object.keys(spec.components.schemas)).toEqual(["Item"]);
  });

  it("keeps required derived from the fields (the half that makes the schema worth having)", () => {
    const spec: any = generate([], [model("items", itemFields, "Item")]);
    expect((spec.components.schemas.Item as any).required).toEqual(["name"]);
  });
});

// ── S3. info.version defaults to 1.0.0, description to "", servers[0].url to / ─
describe("S3 — info defaults", () => {
  it("info.version defaults to 1.0.0 (the app's version, not 0.0.1)", () => {
    const spec: any = generate([], []);
    expect(spec.info.version).toBe("1.0.0");
    expect(spec.info.version).not.toBe("0.0.1");
  });

  it("info.description defaults to the empty string, not a canned sentence", () => {
    const spec: any = generate([], []);
    expect(spec.info.description).toBe("");
    expect(spec.info.description).not.toBe("Auto-generated API documentation");
  });

  it("TINA4_SWAGGER_VERSION still overrides the default", () => {
    process.env.TINA4_SWAGGER_VERSION = "9.9.9";
    const spec: any = generate([], []);
    expect(spec.info.version).toBe("9.9.9");
  });

  it("servers[0].url stays '/' — correct under any port/host/proxy (Node was already right)", () => {
    const spec: any = generate([], []);
    expect(spec.servers?.[0]?.url).toBe("/");
  });
});

// ── S5. one response set on an undecorated route ─────────────────────────────
describe("S5 — undecorated responses: 200, plus 401 only when secured", () => {
  it("an undecorated public GET emits exactly ['200']", () => {
    const spec: any = generate([route("GET", "/api/ping")]);
    expect(responseKeys(spec, "/api/ping", "get")).toEqual(["200"]);
  });

  it("a secured model POST emits 200 + 401 — never an inferred 201 or 422", () => {
    // POST is secure-by-default (the router's write gate), so 401 is legitimate.
    const spec: any = generate([route("POST", "/api/items")], [model("items", itemFields, "Item")]);
    const keys = responseKeys(spec, "/api/items", "post");
    expect(keys).toEqual(["200", "401"]);
    // NEGATIVE: the two fictions the pre-3.13.96 generator stamped on every model write.
    expect(keys).not.toContain("422");
    expect(keys).not.toContain("201");
  });

  it("the 200 on a model POST carries the resource schema (parity with Python master)", () => {
    const spec: any = generate([route("POST", "/api/items")], [model("items", itemFields, "Item")]);
    const ok = (spec.paths["/api/items"].post as any).responses["200"];
    expect(ok.content["application/json"].schema.$ref).toBe("#/components/schemas/Item");
  });

  it("a PUBLIC model write (noAuth) emits just ['200'] — no 401, no 422, no 201", () => {
    const spec: any = generate(
      [route("POST", "/api/items", { noAuth: true })],
      [model("items", itemFields, "Item")],
    );
    expect(responseKeys(spec, "/api/items", "post")).toEqual(["200"]);
  });

  it("an explicit meta.responses is honoured, never clobbered by model inference", () => {
    const spec: any = generate(
      [route("POST", "/api/items", { noAuth: true, meta: { responses: { "201": { description: "Created" } } } as any })],
      [model("items", itemFields, "Item")],
    );
    expect(responseKeys(spec, "/api/items", "post")).toEqual(["201"]);
  });
});

// ── S6. operationId never collides — leading underscores preserved ───────────
describe("S6 — operationId preserves leading underscores so /__health != /health", () => {
  it("/__health and /health produce two DISTINCT ids from the path, not a _2 suffix", () => {
    const spec: any = generate([route("GET", "/__health"), route("GET", "/health")]);
    const idUnder = (spec.paths["/__health"].get as any).operationId;
    const idPlain = (spec.paths["/health"].get as any).operationId;
    expect(idUnder).toBe("get___health");
    expect(idPlain).toBe("get_health");
    expect(idUnder).not.toBe(idPlain);
    // NEGATIVE: the collapse-then-suffix bug produced get_health + get_health_2,
    // where WHICH endpoint gets _2 depends on registration order.
    expect([idUnder, idPlain]).not.toContain("get_health_2");
  });

  it("still de-duplicates genuinely colliding ids with a numeric suffix", () => {
    // Two different paths that legitimately reduce to the same base still need
    // uniqueness — dropping the suffix logic would be just as wrong.
    const spec: any = generate([route("GET", "/api/users/{id}"), route("GET", "/api/users/id")]);
    const a = (spec.paths["/api/users/{id}"].get as any).operationId;
    const b = (spec.paths["/api/users/id"].get as any).operationId;
    expect(a).not.toBe(b);
    expect([a, b].sort()).toEqual(["get_api_users_id", "get_api_users_id_2"]);
  });
});

// ── S1 (shared invariant). The generated document is structurally valid. ──────
// A validator is a TEST-only concern (the framework stays zero-dependency); this
// checks the invariant classes openapi-spec-validator would flag — the two that
// actually made Node's document invalid (unresolved path params) plus dangling
// $refs and duplicate operationIds — over the S1 app-under-test route shapes.
describe("S1 — the document a real generate() produces is structurally valid", () => {
  const appRoutes: RouteDefinition[] = [
    route("GET", "/api/items"),                       // public GET
    route("POST", "/api/items"),                      // secured write (write gate)
    route("GET", "/api/items/{id}"),                  // path param
    route("GET", "/api/orgs/{org}/files/{...slug}"),  // typed-ish + catch-all
  ];
  const appModels = [model("items", itemFields, "Item")];

  it("every {template} in every path has a matching in:path parameter", () => {
    const spec: any = generate(appRoutes, appModels);
    const unresolved: string[] = [];
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      const want = [...path.matchAll(/\{(\.\.\.)?(\w+)\}/g)].map((m) => m[2]);
      for (const [verb, op] of Object.entries<any>(ops)) {
        if (!op || typeof op !== "object") continue;
        const declared = ((op.parameters ?? []) as any[]).filter((p) => p.in === "path").map((p) => p.name);
        for (const w of want) if (!declared.includes(w)) unresolved.push(`${verb} ${path} -> {${w}}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every $ref resolves to a defined components.schemas entry (no dangling refs)", () => {
    const spec: any = generate(appRoutes, appModels);
    const refs: string[] = [];
    JSON.stringify(spec, (k, v) => (k === "$ref" ? refs.push(v as string) : undefined, v));
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(spec.components.schemas[name], `dangling $ref ${ref}`).toBeDefined();
    }
  });

  it("operationIds are unique across the whole document", () => {
    const spec: any = generate(appRoutes, appModels);
    const ids: string[] = [];
    for (const ops of Object.values<any>(spec.paths)) {
      for (const op of Object.values<any>(ops)) if (op?.operationId) ids.push(op.operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every operation carries a non-empty responses object", () => {
    const spec: any = generate(appRoutes, appModels);
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [verb, op] of Object.entries<any>(ops)) {
        expect(Object.keys(op.responses ?? {}).length, `${verb} ${path} has no responses`).toBeGreaterThan(0);
      }
    }
  });
});
