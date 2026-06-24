/**
 * Lock-in regression: Tina4 GraphQL resolvers may be ASYNC.
 *
 * execute() awaits every resolver, so an async (Promise-returning) resolver has
 * its value resolved before the field is serialized — NOT silently serialized
 * as {} (the historical unresolved-Promise bug `{"data":{"ping":{}}}`), and NOT
 * rejected for being async. A synchronous resolver still returns its value
 * (awaiting a plain value is a no-op). A rejected Promise (async resolver that
 * throws) surfaces as a GraphQL error, exactly like a thrown sync exception
 * (masked in prod, detailed under TINA4_DEBUG).
 *
 * Run with: npx tsx test/graphqlAsyncResolver.test.ts
 */
import { GraphQL } from "../packages/core/src/index.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

console.log("=== GraphQL async-resolver contract ===\n");

// 1. A sync resolver still resolves its value through execute().
GraphQL._clearClassResolvers();
GraphQL.resolve("Query", "ping", () => "pong");
const sync = await new GraphQL().execute("{ ping }") as { data?: Record<string, unknown>; errors?: unknown[] };
assert("sync resolver returns its value", sync?.data?.ping === "pong", JSON.stringify(sync));
assert("sync resolver produces no errors", !sync.errors || sync.errors.length === 0, JSON.stringify(sync.errors));

// 2. An async resolver has its value awaited and resolved — never the silent {}.
GraphQL._clearClassResolvers();
GraphQL.resolve("Query", "ping", async () => "pong");
const asyncRes = await new GraphQL().execute("{ ping }") as { data?: Record<string, unknown>; errors?: { message: string }[] };
assert(
  "async resolver does NOT serialize an unresolved Promise as {}",
  JSON.stringify(asyncRes?.data?.ping) !== "{}",
  JSON.stringify(asyncRes),
);
assert("async resolver resolves to its awaited value", asyncRes?.data?.ping === "pong", JSON.stringify(asyncRes));
assert(
  "async resolver produces no errors",
  !asyncRes.errors || asyncRes.errors.length === 0,
  JSON.stringify(asyncRes.errors),
);

// 3. A manually-returned Promise (thenable) is awaited and resolves too.
GraphQL._clearClassResolvers();
GraphQL.resolve("Query", "ping", () => Promise.resolve("pong"));
const thenable = await new GraphQL().execute("{ ping }") as { data?: Record<string, unknown>; errors?: { message: string }[] };
assert(
  "a returned Promise (thenable) resolves to its value",
  thenable?.data?.ping === "pong"
    && (!thenable.errors || thenable.errors.length === 0),
  JSON.stringify(thenable),
);

// 4. An async resolver that throws surfaces as a GraphQL error (data null, errors
//    non-empty). The detail is masked in prod; the masked message is fine.
GraphQL._clearClassResolvers();
GraphQL.resolve("Query", "ping", async () => {
  throw new Error("boom in async resolver");
});
const thrown = await new GraphQL().execute("{ ping }") as { data?: Record<string, unknown>; errors?: { message: string }[] };
assert(
  "async resolver rejection surfaces as a GraphQL error",
  thrown?.data?.ping === null
    && Array.isArray(thrown.errors)
    && thrown.errors.length > 0,
  JSON.stringify(thrown),
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
