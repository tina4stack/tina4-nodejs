/**
 * Unit tests for the Swagger/OpenAPI module.
 * Run with: npx tsx test/swagger.test.ts
 */
import { generate } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition } from "../packages/core/src/index.ts";

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

console.log("=== Swagger Tests ===\n");

// --- Basic spec generation ---
console.log("--- generate basics ---");

const routes: RouteDefinition[] = [
  { method: "GET", pattern: "/api/users", handler: async () => {} },
  { method: "POST", pattern: "/api/users", handler: async () => {} },
  { method: "GET", pattern: "/api/users/[id]", handler: async () => {} },
  { method: "PUT", pattern: "/api/users/[id]", handler: async () => {} },
  { method: "DELETE", pattern: "/api/users/[id]", handler: async () => {} },
];

const models = [
  {
    tableName: "users",
    fields: {
      id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
      name: { type: "string" as const, required: true, minLength: 1, maxLength: 100 },
      email: { type: "string" as const, required: true },
      age: { type: "integer" as const, min: 0, max: 150 },
      bio: { type: "text" as const },
      active: { type: "boolean" as const },
      created_at: { type: "datetime" as const },
      score: { type: "number" as const, min: 0 },
    },
  },
];

const spec = generate(routes, models);

assert("spec has openapi version", spec.openapi === "3.0.3");
assert("spec has info object", spec.info !== undefined);
assert("spec has title", typeof spec.info.title === "string");
assert("spec has version", typeof spec.info.version === "string");
assert("spec has paths object", typeof spec.paths === "object");
assert("spec has components", spec.components !== undefined);
assert("spec has schemas", spec.components?.schemas !== undefined);

// --- Paths ---
console.log("\n--- Paths ---");

assert("paths includes /api/users", "/api/users" in spec.paths);
assert("paths includes /api/users/{id}", "/api/users/{id}" in spec.paths);
assert("GET /api/users documented", spec.paths["/api/users"]?.get !== undefined);
assert("POST /api/users documented", spec.paths["/api/users"]?.post !== undefined);
assert("GET /api/users/{id} documented", spec.paths["/api/users/{id}"]?.get !== undefined);
assert("PUT /api/users/{id} documented", spec.paths["/api/users/{id}"]?.put !== undefined);
assert("DELETE /api/users/{id} documented", spec.paths["/api/users/{id}"]?.delete !== undefined);

// --- Path parameters ---
console.log("\n--- Path parameters ---");

const getUserById = spec.paths["/api/users/{id}"]?.get as Record<string, unknown>;
assert("GET /api/users/{id} has parameters", Array.isArray(getUserById?.parameters));
const params = getUserById?.parameters as Array<Record<string, unknown>>;
assert("parameter name is id", params?.[0]?.name === "id");
assert("parameter is in path", params?.[0]?.in === "path");
assert("parameter is required", params?.[0]?.required === true);

// --- Routes with meta ---
console.log("\n--- Routes with meta ---");

const routesWithMeta: RouteDefinition[] = [
  {
    method: "GET",
    pattern: "/api/products",
    handler: async () => {},
    meta: { summary: "List all products", tags: ["products"] },
  },
];

const metaSpec = generate(routesWithMeta, []);
const getProducts = metaSpec.paths["/api/products"]?.get as Record<string, unknown>;
assert("meta summary is used", getProducts?.summary === "List all products");
assert("meta tags are used", Array.isArray(getProducts?.tags) && (getProducts?.tags as string[])[0] === "products");

// --- Model schema ---
console.log("\n--- Model schema ---");

const userSchema = spec.components?.schemas?.users as Record<string, unknown>;
assert("users schema exists", userSchema !== undefined);
assert("schema type is object", userSchema?.type === "object");

const props = userSchema?.properties as Record<string, Record<string, unknown>>;
assert("schema has id property", props?.id !== undefined);
assert("id is integer type", props?.id?.type === "integer");
assert("id is readOnly (PK + autoIncrement)", props?.id?.readOnly === true);

assert("schema has name property", props?.name !== undefined);
assert("name is string type", props?.name?.type === "string");
assert("name has maxLength", props?.name?.maxLength === 100);
assert("name has minLength", props?.name?.minLength === 1);

assert("schema has age property", props?.age !== undefined);
assert("age is integer type", props?.age?.type === "integer");
assert("age has minimum", props?.age?.minimum === 0);
assert("age has maximum", props?.age?.maximum === 150);

assert("schema has bio property", props?.bio !== undefined);
assert("bio text maps to string", props?.bio?.type === "string");

assert("schema has active property", props?.active !== undefined);
assert("active is boolean type", props?.active?.type === "boolean");

assert("schema has created_at property", props?.created_at !== undefined);
assert("datetime maps to string with format", props?.created_at?.type === "string");
assert("datetime has date-time format", props?.created_at?.format === "date-time");

assert("schema has score property", props?.score !== undefined);
assert("score is number type", props?.score?.type === "number");

// --- Required fields ---
console.log("\n--- Required fields ---");

const required = userSchema?.required as string[];
assert("required array exists", Array.isArray(required));
assert("name is required", required?.includes("name"));
assert("email is required", required?.includes("email"));
assert("id is NOT required (primaryKey)", !required?.includes("id"));

// --- POST request body ---
console.log("\n--- POST request body ---");

const postUsers = spec.paths["/api/users"]?.post as Record<string, unknown>;
const reqBody = postUsers?.requestBody as Record<string, unknown>;
assert("POST has requestBody", reqBody !== undefined);
assert("requestBody is required", reqBody?.required === true);

const content = reqBody?.content as Record<string, unknown>;
const jsonContent = content?.["application/json"] as Record<string, unknown>;
assert("requestBody has application/json", jsonContent !== undefined);

const schema = jsonContent?.schema as Record<string, unknown>;
assert("schema references users model", schema?.$ref === "#/components/schemas/users");

// --- Tag inference ---
console.log("\n--- Tag inference ---");

const routeNoMeta: RouteDefinition[] = [
  { method: "GET", pattern: "/api/orders", handler: async () => {} },
];

const tagSpec = generate(routeNoMeta, []);
const getOrders = tagSpec.paths["/api/orders"]?.get as Record<string, unknown>;
assert("tags inferred from path", Array.isArray(getOrders?.tags) && (getOrders?.tags as string[])[0] === "orders");

// --- Empty spec ---
console.log("\n--- Empty spec ---");

const emptySpec = generate([], []);
assert("empty routes produce empty paths", Object.keys(emptySpec.paths).length === 0);
assert("empty models produce empty schemas", Object.keys(emptySpec.components?.schemas ?? {}).length === 0);

// --- Catch-all routes ---
console.log("\n--- Catch-all routes ---");

const catchAllRoutes: RouteDefinition[] = [
  { method: "GET", pattern: "/api/files/[...path]", handler: async () => {} },
];

const catchSpec = generate(catchAllRoutes, []);
assert("catch-all route converted to {path}", "/api/files/{path}" in catchSpec.paths);

// --- v3.13.40: Security ---
console.log("\n--- Security (v3.13.40) ---");

assert("bearerAuth scheme defined", (spec.components as Record<string, Record<string, Record<string, unknown>>>)?.securitySchemes?.bearerAuth?.scheme === "bearer");
const postSec = (spec.paths["/api/users"]?.post as Record<string, unknown>)?.security as Array<Record<string, unknown>>;
assert("POST is secured by default", Array.isArray(postSec) && postSec[0]?.bearerAuth !== undefined);
assert("GET is not secured by default", (spec.paths["/api/users"]?.get as Record<string, unknown>)?.security === undefined);

const noAuthSpec = generate([{ method: "POST", pattern: "/api/webhook", handler: async () => {}, noAuth: true }], []);
assert("noAuth write has no security", (noAuthSpec.paths["/api/webhook"]?.post as Record<string, unknown>)?.security === undefined);

const secGetSpec = generate([{ method: "GET", pattern: "/api/admin", handler: async () => {}, secure: true }], []);
assert("secured GET gets security", Array.isArray((secGetSpec.paths["/api/admin"]?.get as Record<string, unknown>)?.security));

// --- v3.13.40: foreignKey + default ---
console.log("\n--- foreignKey + default (v3.13.40) ---");

const fkModels = [{
  tableName: "posts",
  fields: {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    author_id: { type: "foreignKey" as const, references: "User" },
    status: { type: "string" as const, default: "draft" },
  },
}];
const fkSpec = generate([], fkModels);
const postsProps = (fkSpec.components?.schemas?.posts as Record<string, Record<string, Record<string, unknown>>>)?.properties;
assert("foreignKey field maps to integer", postsProps?.author_id?.type === "integer");
assert("field default is mapped", postsProps?.status?.default === "draft");

// --- v3.13.40: nested-path inference safety ---
console.log("\n--- nested-path inference (v3.13.40) ---");

const nestedSpec = generate([{ method: "POST", pattern: "/api/users/[id]/comments", handler: async () => {} }], models);
const nestedPost = nestedSpec.paths["/api/users/{id}/comments"]?.post as Record<string, unknown>;
assert("nested path does NOT attach parent model body", nestedPost?.requestBody === undefined);

// --- v3.13.40: meta description/deprecated/example ---
console.log("\n--- meta description/deprecated/example (v3.13.40) ---");

const richSpec = generate([{ method: "POST", pattern: "/api/things", handler: async () => {}, meta: { description: "Create a thing", deprecated: true, example: { name: "x" } } }], []);
const postThings = richSpec.paths["/api/things"]?.post as Record<string, unknown>;
assert("meta description emitted", postThings?.description === "Create a thing");
assert("meta deprecated emitted", postThings?.deprecated === true);
const thingsBody = (postThings?.requestBody as Record<string, Record<string, Record<string, Record<string, unknown>>>>)?.content?.["application/json"]?.example as Record<string, unknown>;
assert("meta example in requestBody", thingsBody?.name === "x");

// --- v3.13.40: operationId + servers + tags[] ---
console.log("\n--- operationId / servers / tags (v3.13.40) ---");

assert("operationId present", typeof (spec.paths["/api/users"]?.get as Record<string, unknown>)?.operationId === "string");
const dupSpec = generate([
  { method: "GET", pattern: "/api/users/[id]", handler: async () => {} },
  { method: "GET", pattern: "/api/users/id", handler: async () => {} },
], []);
const dupId1 = (dupSpec.paths["/api/users/{id}"]?.get as Record<string, unknown>)?.operationId;
const dupId2 = (dupSpec.paths["/api/users/id"]?.get as Record<string, unknown>)?.operationId;
assert("operationIds are unique", dupId1 !== dupId2);

assert("spec has servers", Array.isArray(spec.servers) && spec.servers.length > 0);
process.env.TINA4_SWAGGER_SERVERS = "https://a.test,https://b.test";
const multiSpec = generate([], []);
delete process.env.TINA4_SWAGGER_SERVERS;
assert("multi-server from env", multiSpec.servers?.length === 2 && multiSpec.servers?.[0]?.url === "https://a.test");

assert("top-level tags array", Array.isArray(spec.tags) && (spec.tags as Array<{ name: string }>).some((t) => t.name === "users"));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
