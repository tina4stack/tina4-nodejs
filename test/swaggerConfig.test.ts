/**
 * Swagger v3.13.42 configurability — new-behaviour contract tests.
 *
 * Mirrors tina4-python/tests/test_swagger_v3_13_42.py. Locks the four gaps:
 *   1. Configurable security schemes (bearerFormat, apiKey) + per-route security + scopes
 *   2. Path include/exclude filtering (framework internals always excluded)
 *   3. OpenAPI 3.1 opt-in (default 3.0.3)
 *   4. Reusable custom component schemas via addSchema + meta.requestSchema/responseSchemas
 *
 * Run with: npx tsx test/swaggerConfig.test.ts
 */
import { generate, addSecurityScheme, addSchema, resetRegistry } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition, RouteMeta } from "../packages/core/src/index.ts";

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

// Isolate each case from registry + env leakage.
const ENV_KEYS = [
  "TINA4_SWAGGER_OPENAPI", "TINA4_SWAGGER_BEARER_FORMAT",
  "TINA4_SWAGGER_API_KEY_NAME", "TINA4_SWAGGER_API_KEY_IN",
  "TINA4_SWAGGER_DEFAULT_SCHEME", "TINA4_SWAGGER_INCLUDE", "TINA4_SWAGGER_EXCLUDE",
];
function clean() {
  resetRegistry();
  for (const k of ENV_KEYS) delete process.env[k];
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function route(method: string, pattern: string, meta?: RouteMeta, extra: Partial<RouteDefinition> = {}): RouteDefinition {
  return { method, pattern, handler: async () => {}, meta, ...extra };
}

console.log("=== Swagger Configurability Tests (v3.13.42) ===\n");

// ── OpenAPI version ───────────────────────────────────────────────
console.log("--- OpenAPI version ---");
clean();
assert("default is 3.0.3", generate([], []).openapi === "3.0.3");

clean();
process.env.TINA4_SWAGGER_OPENAPI = "3.1";
assert("opt-in 3.1 -> 3.1.0", generate([], []).openapi === "3.1.0");
clean();

// ── Configurable security schemes ─────────────────────────────────
console.log("\n--- Configurable security schemes ---");
clean();
process.env.TINA4_SWAGGER_BEARER_FORMAT = "opaque";
{
  const schemes = generate([], []).components?.securitySchemes as Record<string, Record<string, unknown>>;
  assert("bearerFormat configurable", schemes.bearerAuth?.bearerFormat === "opaque");
}
clean();

process.env.TINA4_SWAGGER_API_KEY_NAME = "X-Api-Key";
{
  const schemes = generate([], []).components?.securitySchemes as Record<string, Record<string, unknown>>;
  assert("apiKey scheme from env", eq(schemes.apiKeyAuth, { type: "apiKey", name: "X-Api-Key", in: "header" }));
}
clean();

process.env.TINA4_SWAGGER_API_KEY_NAME = "X-Api-Key";
process.env.TINA4_SWAGGER_DEFAULT_SCHEME = "apiKeyAuth";
{
  const spec = generate([route("post", "/api/v1/things", undefined, { secure: true })], []);
  const op = spec.paths["/api/v1/things"]?.post as Record<string, unknown>;
  assert("default scheme drives secured routes", eq(op.security, [{ apiKeyAuth: [] }]));
}
clean();

addSecurityScheme("oauth2", {
  type: "oauth2",
  flows: { clientCredentials: { tokenUrl: "https://x/token", scopes: { "read:users": "Read" } } },
});
{
  const schemes = generate([], []).components?.securitySchemes as Record<string, Record<string, unknown>>;
  assert("registered scheme appears", schemes.oauth2?.type === "oauth2");
}
clean();

// ── Per-route security + scopes ───────────────────────────────────
console.log("\n--- Per-route security + scopes ---");
clean();
{
  const spec = generate([route("get", "/api/v1/me", { security: "bearerAuth" })], []);
  const op = spec.paths["/api/v1/me"]?.get as Record<string, unknown>;
  assert("explicit security overrides default", eq(op.security, [{ bearerAuth: [] }]));
}
clean();

{
  // secure: true, but security "public" wins -> explicitly open.
  const spec = generate([route("post", "/api/v1/webhook", { security: "public" }, { secure: true })], []);
  const op = spec.paths["/api/v1/webhook"]?.post as Record<string, unknown>;
  assert("public marks no security", eq(op.security, []));
}
clean();

addSecurityScheme("oauth2", {
  type: "oauth2",
  flows: { clientCredentials: { tokenUrl: "https://x/token", scopes: { "read:users": "Read", "write:users": "Write" } } },
});
{
  const spec = generate([route("get", "/api/v1/users", { security: "oauth2", scopes: ["read:users", "write:users"] })], []);
  const op = spec.paths["/api/v1/users"]?.get as Record<string, unknown>;
  assert("oauth2 scopes preserved", eq(op.security, [{ oauth2: ["read:users", "write:users"] }]));
}
clean();

{
  // Scopes on an http/bearer scheme are invalid OpenAPI -> sanitized to [].
  const spec = generate([route("get", "/api/v1/users", { security: "bearerAuth", scopes: ["read:users"] })], []);
  const op = spec.paths["/api/v1/users"]?.get as Record<string, unknown>;
  assert("scopes dropped on non-oauth2 scheme", eq(op.security, [{ bearerAuth: [] }]));
}
clean();

addSecurityScheme("oauth2", { type: "oauth2", flows: {} });
{
  const spec = generate([route("get", "/api/v1/x", { security: [{ oauth2: ["read"] }, { bearerAuth: [] }] })], []);
  const op = spec.paths["/api/v1/x"]?.get as Record<string, unknown>;
  assert("OR requirements verbatim", eq(op.security, [{ oauth2: ["read"] }, { bearerAuth: [] }]));
}
clean();

// ── Path filtering ────────────────────────────────────────────────
console.log("\n--- Path filtering ---");
function filterRoutes(): RouteDefinition[] {
  return [
    route("get", "/api/v1/users"),
    route("get", "/dashboard"),
    route("get", "/__dev/api/reload"),
    route("get", "/swagger"),
  ];
}
clean();
{
  const paths = generate(filterRoutes(), []).paths;
  assert("internals: /__dev excluded", !("/__dev/api/reload" in paths));
  assert("internals: /swagger excluded", !("/swagger" in paths));
  assert("internals: /api/v1/users kept", "/api/v1/users" in paths);
}
clean();

process.env.TINA4_SWAGGER_INCLUDE = "/api/v1";
{
  const paths = generate(filterRoutes(), []).paths;
  assert("include allow-list", eq(Object.keys(paths).sort(), ["/api/v1/users"]));
}
clean();

process.env.TINA4_SWAGGER_EXCLUDE = "/dashboard";
{
  const paths = generate(filterRoutes(), []).paths;
  assert("exclude prefix drops /dashboard", !("/dashboard" in paths) && "/api/v1/users" in paths);
}
clean();

// ── Reusable custom schemas ───────────────────────────────────────
console.log("\n--- Reusable custom schemas ---");
clean();
addSchema("CreateUser", {
  type: "object",
  properties: { email: { type: "string" }, name: { type: "string" } },
  required: ["email"],
});
{
  const spec = generate([route("post", "/api/v1/users", { requestSchema: "CreateUser" })], []);
  const body = (spec.paths["/api/v1/users"]?.post as Record<string, Record<string, Record<string, Record<string, unknown>>>>)?.requestBody;
  const schema = body?.content?.["application/json"]?.schema;
  assert("requestSchema $ref", eq(schema, { $ref: "#/components/schemas/CreateUser" }));
  assert("CreateUser registered in components.schemas", "CreateUser" in (spec.components?.schemas ?? {}));
}
clean();

addSchema("User", { type: "object", properties: { id: { type: "integer" } } });
{
  const spec = generate([route("get", "/api/v1/users", {
    responseSchemas: { "200": "User", "201": { name: "User", isList: true } },
  })], []);
  const resps = (spec.paths["/api/v1/users"]?.get as Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>)?.responses;
  assert("response 200 $ref", eq(resps?.["200"]?.content?.["application/json"]?.schema, { $ref: "#/components/schemas/User" }));
  assert("response 201 list $ref", eq(resps?.["201"]?.content?.["application/json"]?.schema, {
    type: "array", items: { $ref: "#/components/schemas/User" },
  }));
  assert("User registered in components.schemas", "User" in (spec.components?.schemas ?? {}));
}
clean();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
