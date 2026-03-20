/**
 * Unit tests for the Swagger/OpenAPI module.
 * Run with: npx tsx test/swagger.test.ts
 */
import { generateOpenAPISpec } from "../packages/swagger/src/generator.ts";
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
console.log("--- generateOpenAPISpec basics ---");

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

const spec = generateOpenAPISpec(routes, models);

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

const metaSpec = generateOpenAPISpec(routesWithMeta, []);
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

const tagSpec = generateOpenAPISpec(routeNoMeta, []);
const getOrders = tagSpec.paths["/api/orders"]?.get as Record<string, unknown>;
assert("tags inferred from path", Array.isArray(getOrders?.tags) && (getOrders?.tags as string[])[0] === "orders");

// --- Empty spec ---
console.log("\n--- Empty spec ---");

const emptySpec = generateOpenAPISpec([], []);
assert("empty routes produce empty paths", Object.keys(emptySpec.paths).length === 0);
assert("empty models produce empty schemas", Object.keys(emptySpec.components?.schemas ?? {}).length === 0);

// --- Catch-all routes ---
console.log("\n--- Catch-all routes ---");

const catchAllRoutes: RouteDefinition[] = [
  { method: "GET", pattern: "/api/files/[...path]", handler: async () => {} },
];

const catchSpec = generateOpenAPISpec(catchAllRoutes, []);
assert("catch-all route converted to {path}", "/api/files/{path}" in catchSpec.paths);

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
