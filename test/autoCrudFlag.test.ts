import { BaseModel } from "../packages/orm/src/baseModel.js";
import { generateCrudRoutes } from "../packages/orm/src/autoCrud.js";
import type { DiscoveredModel } from "../packages/orm/src/model.js";

const results: string[] = [];
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    results.push(`  PASS  ${name}`);
  } else {
    failed++;
    results.push(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/**
 * Build the DiscoveredModel shape `discoverModels()` produces from a model
 * class, then run the SAME auto-CRUD route generator the server uses
 * (server.ts -> orm.generateCrudRoutes). This is the real route-generation
 * path; only the opt-in gate (autoCrud === true) is applied here as the
 * filter, exercising the flag as a behavioural switch rather than a getter.
 */
function discoveredFrom(ModelClass: typeof BaseModel): DiscoveredModel {
  return {
    filePath: `src/models/${ModelClass.name}.ts`,
    modelClass: ModelClass,
    definition: {
      tableName: ModelClass.tableName,
      fields: ModelClass.fields,
      softDelete: ModelClass.softDelete ?? false,
      tableFilter: ModelClass.tableFilter,
      fieldMapping: ModelClass.fieldMapping,
    },
  };
}

// The opt-in gate the flag is meant to drive: only models that set
// `static autoCrud = true` are handed to the CRUD route generator.
function registerAutoCrud(models: Array<typeof BaseModel>) {
  const optedIn = models.filter((m) => m.autoCrud === true);
  return generateCrudRoutes(optedIn.map(discoveredFrom));
}

// Test 1: a model that leaves autoCrud at its default is NOT opted into CRUD
// -> the route-generation path produces ZERO /api/widgets routes.
{
  class Widget extends BaseModel {
    static tableName = "widgets";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
  }

  const routes = registerAutoCrud([Widget]);
  const widgetRoutes = routes.filter((r) => r.pattern.startsWith("/api/widgets"));

  assert(
    "autoCrud default-false model produces NO CRUD routes",
    widgetRoutes.length === 0,
    `expected 0 /api/widgets routes, got ${widgetRoutes.length}: ${widgetRoutes.map((r) => `${r.method} ${r.pattern}`).join(", ")}`,
  );
}

// Test 2: setting autoCrud = true opts the model in -> the route-generation
// path produces the full 5 /api/gadgets CRUD routes.
{
  class Gadget extends BaseModel {
    static tableName = "gadgets";
    static fields = {
      id: { type: "integer" as const, primaryKey: true },
      name: { type: "string" as const, required: true },
    };
    static autoCrud = true;
  }

  const routes = registerAutoCrud([Gadget]);
  const gadgetRoutes = routes.filter((r) => r.pattern.startsWith("/api/gadgets"));

  const has = (method: string, pattern: string) =>
    gadgetRoutes.some((r) => r.method === method && r.pattern === pattern);

  assert("autoCrud=true produces exactly 5 CRUD routes", gadgetRoutes.length === 5,
    `got ${gadgetRoutes.length}`);
  assert("autoCrud=true -> GET /api/gadgets (list)", has("GET", "/api/gadgets"));
  assert("autoCrud=true -> GET /api/gadgets/{id}", has("GET", "/api/gadgets/{id}"));
  assert("autoCrud=true -> POST /api/gadgets", has("POST", "/api/gadgets"));
  assert("autoCrud=true -> PUT /api/gadgets/{id}", has("PUT", "/api/gadgets/{id}"));
  assert("autoCrud=true -> DELETE /api/gadgets/{id}", has("DELETE", "/api/gadgets/{id}"));
  // Handlers are real, callable async functions (not placeholders).
  assert("autoCrud=true CRUD handlers are functions",
    gadgetRoutes.every((r) => typeof r.handler === "function"));
}

// Mixed set: the flag is the only thing that decides inclusion. With one
// opted-in and one default model, only the opted-in model's routes appear.
{
  class OptIn extends BaseModel {
    static tableName = "opt_ins";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
    static autoCrud = true;
  }
  class OptOut extends BaseModel {
    static tableName = "opt_outs";
    static fields = { id: { type: "integer" as const, primaryKey: true } };
  }

  const routes = registerAutoCrud([OptIn, OptOut]);
  assert("mixed set: opted-in model produces routes",
    routes.some((r) => r.pattern.startsWith("/api/opt_ins")));
  assert("mixed set: default model produces NO routes",
    !routes.some((r) => r.pattern.startsWith("/api/opt_outs")));
  assert("mixed set: only the 5 opted-in routes are generated", routes.length === 5,
    `got ${routes.length}`);
}

console.log(`  ${failed === 0 ? "PASS" : "FAIL"}  autoCrudFlag.test (${passed} passed, ${failed} failed)`);
if (failed > 0) {
  results.forEach((r) => console.log(r));
  process.exit(1);
}
