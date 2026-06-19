/**
 * Unit tests for the GraphQL module (Phase 5).
 * Run with: npx tsx test/graphql.test.ts
 */
import { GraphQL, ParseError } from "../packages/core/src/index.ts";

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

console.log("=== GraphQL Tests ===\n");

// --- Type Registration ---
console.log("--- Type Registration ---");

const gql = new GraphQL();
const result = gql.addType("User", {
  id: { type: "ID" },
  name: { type: "String" },
  email: { type: "String" },
});
assert("addType returns GraphQL instance (chaining)", result === gql);

const schema = gql.schemaSdl();
assert("schema contains type User", schema.includes("type User {"));
assert("schema contains field id: ID", schema.includes("id: ID"));
assert("schema contains field name: String", schema.includes("name: String"));

// --- Query Registration ---
console.log("\n--- Query Registration ---");

const users = [
  { id: "1", name: "Alice", email: "alice@test.com" },
  { id: "2", name: "Bob", email: "bob@test.com" },
];

gql.addQuery("user", { id: "ID!" }, "User", (root, args) => {
  return users.find(u => u.id === args.id);
});

gql.addQuery("users", {}, "[User]", () => users);

const querySchema = gql.schemaSdl();
assert("schema contains Query type", querySchema.includes("type Query {"));
assert("schema contains user query with args", querySchema.includes("user(id: ID!): User"));
assert("schema contains users query", querySchema.includes("users: [User]"));

// --- Simple Query Execution ---
console.log("\n--- Simple Query Execution ---");

const r1 = gql.execute('{ user(id: "1") { name email } }');
assert("query returns data", r1.data !== null);
assert("query returns correct name", (r1.data as any)?.user?.name === "Alice");
assert("query returns correct email", (r1.data as any)?.user?.email === "alice@test.com");
assert("query has no errors", r1.errors === undefined);

// --- List Query ---
console.log("\n--- List Query ---");

const r2 = gql.execute("{ users { id name } }");
assert("list query returns array", Array.isArray((r2.data as any)?.users));
assert("list query returns 2 users", (r2.data as any)?.users?.length === 2);
assert("list query first user is Alice", (r2.data as any)?.users?.[0]?.name === "Alice");
assert("list query selects only requested fields", (r2.data as any)?.users?.[0]?.email === undefined);

// --- Mutation ---
console.log("\n--- Mutation ---");

let lastCreated: any = null;
gql.addMutation("createUser", { name: "String!", email: "String!" }, "User", (root, args) => {
  lastCreated = { id: "3", name: args.name, email: args.email };
  return lastCreated;
});

const r3 = gql.execute('mutation { createUser(name: "Eve", email: "eve@test.com") { id name } }');
assert("mutation returns data", r3.data !== null);
assert("mutation returns created user", (r3.data as any)?.createUser?.name === "Eve");
assert("mutation resolver was called", lastCreated !== null && lastCreated.name === "Eve");

const mutationSchema = gql.schemaSdl();
assert("schema contains Mutation type", mutationSchema.includes("type Mutation {"));

// --- Variables ---
console.log("\n--- Variables ---");

const r4 = gql.execute(
  'query GetUser($userId: ID!) { user(id: $userId) { name } }',
  { userId: "2" },
);
assert("variable substitution works", (r4.data as any)?.user?.name === "Bob");

// --- Variable Default ---
console.log("\n--- Variable Default ---");

gql.addQuery("greeting", { name: "String" }, "String", (root, args) => {
  return `Hello, ${args.name}!`;
});

const r5 = gql.execute(
  'query Greet($name: String = "World") { greeting(name: $name) }',
);
assert("variable default applied", (r5.data as any)?.greeting === "Hello, World!");

// --- Aliases ---
console.log("\n--- Aliases ---");

const r6 = gql.execute('{ first: user(id: "1") { name } second: user(id: "2") { name } }');
assert("alias first resolves", (r6.data as any)?.first?.name === "Alice");
assert("alias second resolves", (r6.data as any)?.second?.name === "Bob");

// --- Nested Objects ---
console.log("\n--- Nested Objects ---");

const gql2 = new GraphQL();
gql2.addType("Post", { id: { type: "ID" }, title: { type: "String" } });
gql2.addType("Author", {
  id: { type: "ID" },
  name: { type: "String" },
  posts: { type: "[Post]" },
});

gql2.addQuery("author", { id: "ID!" }, "Author", (root, args) => {
  return {
    id: args.id,
    name: "Jane",
    posts: [
      { id: "p1", title: "First Post" },
      { id: "p2", title: "Second Post" },
    ],
  };
});

const r7 = gql2.execute('{ author(id: "1") { name posts { title } } }');
assert("nested query returns author", (r7.data as any)?.author?.name === "Jane");
assert("nested query returns posts array", Array.isArray((r7.data as any)?.author?.posts));
assert("nested posts have titles", (r7.data as any)?.author?.posts?.[0]?.title === "First Post");

// --- Error Handling ---
console.log("\n--- Error Handling ---");

// NOTE (security hardening): a resolver exception is now MASKED in production
// (TINA4_DEBUG unset/falsy) — the real cause is logged via Log.error, never
// leaked to the client. The detail is only surfaced under TINA4_DEBUG. This
// contract test was updated from asserting the leaked message to asserting the
// masked message; a debug variant follows.
const savedDebugGql = process.env.TINA4_DEBUG;
const savedOutGql = process.env.TINA4_LOG_OUTPUT;
process.env.TINA4_LOG_OUTPUT = "file"; // keep test stdout clean

const gql3 = new GraphQL();
gql3.addQuery("broken", {}, "String", () => {
  throw new Error("Something went wrong");
});

// NEGATIVE/prod: detail is masked, path preserved.
delete process.env.TINA4_DEBUG;
const r8 = gql3.execute("{ broken }");
assert("error query has errors array", r8.errors !== undefined && r8.errors.length > 0);
assert("error message is masked in prod", r8.errors![0].message === "Internal server error");
assert("error detail not leaked in prod", r8.errors![0].message !== "Something went wrong");
assert("error path preserved", JSON.stringify(r8.errors![0].path) === JSON.stringify(["broken"]));
assert("error field is null in data", (r8.data as any)?.broken === null);

// POSITIVE/debug: the real cause is surfaced for local development.
process.env.TINA4_DEBUG = "true";
const gql3b = new GraphQL();
gql3b.addQuery("broken", {}, "String", () => {
  throw new Error("Something went wrong");
});
const r8b = gql3b.execute("{ broken }");
assert("error detail surfaced under TINA4_DEBUG", r8b.errors![0].message === "Something went wrong");
assert("error path preserved in debug", JSON.stringify(r8b.errors![0].path) === JSON.stringify(["broken"]));

// restore env after the masking block
if (savedDebugGql === undefined) delete process.env.TINA4_DEBUG;
else process.env.TINA4_DEBUG = savedDebugGql;
if (savedOutGql === undefined) delete process.env.TINA4_LOG_OUTPUT;
else process.env.TINA4_LOG_OUTPUT = savedOutGql;

// --- Parse Error ---
console.log("\n--- Parse Error ---");

const r9 = gql3.execute("{ broken(");
assert("parse error returns errors", r9.errors !== undefined && r9.errors.length > 0);
assert("parse error has null data", r9.data === null);

// --- No Operation ---
console.log("\n--- No Operation ---");

const r10 = new GraphQL().execute("");
assert("empty query returns error", r10.errors !== undefined && r10.errors.length > 0);

// --- Number and Boolean Args ---
console.log("\n--- Number and Boolean Args ---");

const gql4 = new GraphQL();
gql4.addQuery("math", { x: "Int", y: "Int" }, "Int", (root, args) => {
  return (args.x as number) + (args.y as number);
});

const r11 = gql4.execute("{ math(x: 10, y: 20) }");
assert("integer args parsed correctly", (r11.data as any)?.math === 30);

// --- Schema SDL Output ---
console.log("\n--- Schema SDL ---");

const gql5 = new GraphQL();
gql5.addType("Product", { id: { type: "ID" }, price: { type: "Float" } });
gql5.addQuery("product", { id: "ID!" }, "Product", () => null);
gql5.addMutation("deleteProduct", { id: "ID!" }, "Boolean", () => true);

const sdl = gql5.schemaSdl();
assert("SDL contains type definition", sdl.includes("type Product {"));
assert("SDL contains query type", sdl.includes("type Query {"));
assert("SDL contains mutation type", sdl.includes("type Mutation {"));

// --- Recursion depth guard (item 4) ---
console.log("\n--- Depth Guard ---");

// Default maxDepth reads from TINA4_GRAPHQL_MAX_DEPTH (50 when unset).
assert("default maxDepth is 50", new GraphQL().maxDepth === 50);

// Build a self-referential tree resolver so we can drive arbitrary nesting.
function makeTreeGql(maxDepth: number): GraphQL {
  const g = new GraphQL();
  g.addType("Tree", { id: { type: "ID" }, child: { type: "Tree" } });
  g.addQuery("tree", {}, "Tree", () => ({
    id: "1",
    child: { id: "2", child: { id: "3", child: { id: "4", child: { id: "5" } } } },
  }));
  g.maxDepth = maxDepth;
  return g;
}

// NEGATIVE: an over-deep query is rejected with the structured depth error.
const deepGql = makeTreeGql(2);
const deepRes = deepGql.execute("{ tree { child { child { id } } } }");
assert(
  "over-deep query rejected",
  deepRes.errors !== undefined
    && deepRes.errors.some((e) => e.message === "Query exceeds maximum depth of 2"),
);

// POSITIVE: a shallow query within the limit is allowed.
const shallowRes = makeTreeGql(5).execute("{ tree { id } }");
assert("shallow query allowed", shallowRes.errors === undefined && (shallowRes.data as any)?.tree?.id === "1");

// NEGATIVE: a circular fragment (A spreads itself) is caught by the depth
// guard — depth increments on every fragment spread, so it cannot loop forever.
const circGql = new GraphQL();
circGql.addType("Node", { id: { type: "ID" }, child: { type: "Node" } });
circGql.addQuery("node", {}, "Node", () => ({
  id: "1",
  child: { id: "2", child: { id: "3", child: { id: "4" } } },
}));
circGql.maxDepth = 3;
const circRes = circGql.execute("{ node { ...A } } fragment A on Node { id child { ...A } }");
assert(
  "circular fragment rejected",
  circRes.errors !== undefined
    && circRes.errors.some((e) => e.message === "Query exceeds maximum depth of 3"),
);

// maxDepth <= 0 disables the guard — even a deep query passes.
const offGql = makeTreeGql(0);
const offRes = offGql.execute("{ tree { child { child { child { id } } } } }");
assert("maxDepth<=0 disables guard", offRes.errors === undefined);

// Fragment spreads and inline fragments resolve normally within the limit.
const fragGql = new GraphQL();
fragGql.addType("User", { id: { type: "ID" }, name: { type: "String" } });
fragGql.addQuery("user", { id: "ID!" }, "User", () => ({ id: "1", name: "Alice" }));
const spreadRes = fragGql.execute('{ user(id: "1") { ...UF } } fragment UF on User { name }');
assert("fragment spread resolves", (spreadRes.data as any)?.user?.name === "Alice");
const inlineRes = fragGql.execute('{ user(id: "1") { ... on User { name } } }');
assert("inline fragment resolves", (inlineRes.data as any)?.user?.name === "Alice");

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
