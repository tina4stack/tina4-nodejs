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

const schema = gql.schema();
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

const querySchema = gql.schema();
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

const mutationSchema = gql.schema();
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

const gql3 = new GraphQL();
gql3.addQuery("broken", {}, "String", () => {
  throw new Error("Something went wrong");
});

const r8 = gql3.execute("{ broken }");
assert("error query has errors array", r8.errors !== undefined && r8.errors.length > 0);
assert("error message is captured", r8.errors![0].message === "Something went wrong");
assert("error field is null in data", (r8.data as any)?.broken === null);

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

const sdl = gql5.schema();
assert("SDL contains type definition", sdl.includes("type Product {"));
assert("SDL contains query type", sdl.includes("type Query {"));
assert("SDL contains mutation type", sdl.includes("type Mutation {"));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
