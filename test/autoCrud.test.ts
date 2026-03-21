/**
 * Unit tests for auto-CRUD route generation (autoCrud.ts).
 * Run with: npx tsx test/autoCrud.test.ts
 */
import { generateCrudRoutes } from "../packages/orm/src/index.ts";
import type { DiscoveredModel } from "../packages/orm/src/index.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/index.ts";

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

console.log("=== Auto-CRUD Route Generation Tests ===\n");

// --- Basic CRUD route generation ---
console.log("--- Basic CRUD Routes ---");

const userModel: DiscoveredModel = {
  filePath: "src/models/User.ts",
  definition: {
    tableName: "users",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string", required: true },
      email: { type: "string", required: true },
      active: { type: "boolean" },
    },
  },
};

const routes = generateCrudRoutes([userModel]);

assert("Generates 5 CRUD routes per model", routes.length === 5);
assert("GET /api/users (list)", routes.some(r => r.method === "GET" && r.pattern === "/api/users"));
assert("GET /api/users/{id}", routes.some(r => r.method === "GET" && r.pattern === "/api/users/{id}"));
assert("POST /api/users", routes.some(r => r.method === "POST" && r.pattern === "/api/users"));
assert("PUT /api/users/{id}", routes.some(r => r.method === "PUT" && r.pattern === "/api/users/{id}"));
assert("DELETE /api/users/{id}", routes.some(r => r.method === "DELETE" && r.pattern === "/api/users/{id}"));

// --- Meta / Swagger ---
console.log("\n--- Route Metadata ---");

const listRoute = routes.find(r => r.method === "GET" && r.pattern === "/api/users");
assert("List route has meta.summary", listRoute?.meta?.summary === "List users");
assert("List route has meta.tags", Array.isArray(listRoute?.meta?.tags) && listRoute!.meta!.tags![0] === "users");

const getByIdRoute = routes.find(r => r.method === "GET" && r.pattern === "/api/users/{id}");
assert("Get-by-ID route has summary", getByIdRoute?.meta?.summary === "Get users by ID");

const postRoute = routes.find(r => r.method === "POST" && r.pattern === "/api/users");
assert("POST route has summary", postRoute?.meta?.summary === "Create users");

const putRoute = routes.find(r => r.method === "PUT" && r.pattern === "/api/users/{id}");
assert("PUT route has summary", putRoute?.meta?.summary === "Update users");

const deleteRoute = routes.find(r => r.method === "DELETE" && r.pattern === "/api/users/{id}");
assert("DELETE route has summary", deleteRoute?.meta?.summary === "Delete users");

// --- Multiple models ---
console.log("\n--- Multiple Models ---");

const productModel: DiscoveredModel = {
  filePath: "src/models/Product.ts",
  definition: {
    tableName: "products",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "string", required: true },
      price: { type: "number" },
    },
  },
};

const multiRoutes = generateCrudRoutes([userModel, productModel]);
assert("Two models generate 10 routes", multiRoutes.length === 10);
assert("Has /api/products routes", multiRoutes.some(r => r.pattern === "/api/products"));
assert("Has /api/users routes", multiRoutes.some(r => r.pattern === "/api/users"));

// --- Empty models ---
console.log("\n--- Edge Cases ---");

const emptyRoutes = generateCrudRoutes([]);
assert("No models produces no routes", emptyRoutes.length === 0);

// --- Handler is async function ---
for (const route of routes) {
  assert(`${route.method} ${route.pattern} handler is a function`, typeof route.handler === "function");
}

// --- Soft delete model ---
console.log("\n--- Soft Delete Model ---");

const softDeleteModel: DiscoveredModel = {
  filePath: "src/models/Post.ts",
  definition: {
    tableName: "posts",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      title: { type: "string", required: true },
    },
    softDelete: true,
  },
};

const softRoutes = generateCrudRoutes([softDeleteModel]);
assert("Soft delete model generates 5 routes", softRoutes.length === 5);

// --- Table filter model ---
console.log("\n--- Table Filter Model ---");

const filteredModel: DiscoveredModel = {
  filePath: "src/models/Active.ts",
  definition: {
    tableName: "items",
    fields: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      status: { type: "string" },
    },
    tableFilter: "status = 'active'",
  },
};

const filteredRoutes = generateCrudRoutes([filteredModel]);
assert("Table filter model generates 5 routes", filteredRoutes.length === 5);

// --- Custom primary key ---
console.log("\n--- Custom Primary Key ---");

const customPkModel: DiscoveredModel = {
  filePath: "src/models/Custom.ts",
  definition: {
    tableName: "custom_items",
    fields: {
      item_id: { type: "integer", primaryKey: true, autoIncrement: true },
      label: { type: "string" },
    },
  },
};

const customPkRoutes = generateCrudRoutes([customPkModel]);
assert("Custom PK model generates correct routes", customPkRoutes.length === 5);
assert("Base path uses table name", customPkRoutes.some(r => r.pattern === "/api/custom_items"));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
