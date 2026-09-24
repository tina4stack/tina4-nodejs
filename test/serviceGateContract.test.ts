// The TINA4_REQUIRE_SERVICES gate itself (test/_serviceGate.ts).
//
// Rule, the same in all four frameworks: under the gate a skip passes only
// when its reason carries a machine-readable [needs:X] tag and X is excusable
// in this run - an optional engine only while its coordinate env var is unset,
// an always-provisioned service never, any other tag (a platform exclusion)
// always. An untagged skip fails. With the gate off nothing fails.
//
// Pure logic over the skip text and an explicit environment map: no service,
// no double.
//
// Run with: npx tsx test/serviceGateContract.test.ts

import { gateFailures, isExcusedSkip, needsTags } from "./_serviceGate.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const skipLine = (reason: string): string => `  \x1b[33mSKIP\x1b[0m ${reason}`;
const failing = (reason: string, env: Record<string, string>, gateOn = true): number =>
  gateFailures(skipLine(reason), gateOn, env).length;

console.log("\n--- an_untagged_skip_fails_under_the_gate ---");
const UNTAGGED = "an_untagged_skip_fails_under_the_gate";
const OPTIONAL = "an_optional_engine_is_excused_only_while_its_coordinate_is_unset";
const ALWAYS = "an_always_provisioned_service_is_never_excused";
const PLATFORM = "a_platform_tag_is_always_excused";
assert(`${UNTAGGED}: a 'not reachable' skip fails`, failing("redis not reachable at localhost:6379", {}) === 1);
assert(`${UNTAGGED}: a 'no reachable' skip fails (the phrase the old matcher missed)`,
  failing("no reachable MongoDB at mongodb://localhost:27017", {}) === 1);
assert(`${UNTAGGED}: an '... unavailable' skip fails`, failing("GreenMail unavailable", {}) === 1);
assert(`${UNTAGGED}: an unrelated skip fails`, failing("no free base port in 64536-65500", {}) === 1);

console.log(`\n--- ${OPTIONAL} ---`);
assert(`${OPTIONAL}: firebird excused with TINA4_TEST_FIREBIRD_URL unset`,
  failing("[needs:firebird] TINA4_TEST_FIREBIRD_URL not set", {}) === 0);
assert(`${OPTIONAL}: firebird fails with TINA4_TEST_FIREBIRD_URL set`,
  failing("[needs:firebird] firebird not reachable", { TINA4_TEST_FIREBIRD_URL: "firebird://h/db" }) === 1);
assert(`${OPTIONAL}: an empty coordinate counts as unset`,
  failing("[needs:firebird] not configured", { TINA4_TEST_FIREBIRD_URL: "  " }) === 0);
assert(`${OPTIONAL}: postgres fails when TINA4_TEST_PG_URL is set`,
  failing("[needs:postgres] down", { TINA4_TEST_PG_URL: "postgres://h/db" }) === 1);
for (const [engine, coordinate] of [
  ["postgis", "TINA4_TEST_POSTGIS_URL"], ["mysql", "TINA4_TEST_MYSQL_URL"], ["mssql", "TINA4_TEST_MSSQL_URL"], ["swoole", "TINA4_TEST_SWOOLE"],
  ["oidc", "TINA4_TEST_OIDC_ISSUER"], ["neo4j", "TINA4_TEST_NEO4J_URL"], ["memgraph", "TINA4_TEST_MEMGRAPH_URL"],
  ["arango", "TINA4_TEST_ARANGO_URL"], ["ultipa", "TINA4_TEST_ULTIPA_URL"],
]) {
  assert(`${OPTIONAL}: ${engine} excused while ${coordinate} is unset`, failing(`[needs:${engine}] not set`, {}) === 0);
  assert(`${OPTIONAL}: ${engine} fails once ${coordinate} is set`, failing(`[needs:${engine}] down`, { [coordinate]: "x" }) === 1);
}

console.log(`\n--- ${ALWAYS} ---`);
for (const service of ["mongo", "redis", "valkey", "memcached", "rabbitmq", "kafka", "mqtt", "smtp", "imap", "s3"]) {
  assert(`${ALWAYS}: [needs:${service}] fails with no coordinate set`, failing(`[needs:${service}] not reachable`, {}) === 1);
}

console.log(`\n--- ${PLATFORM} ---`);
assert(`${PLATFORM}: absent-ext excused`, failing("[needs:absent-ext=pgsql] extension not loaded", {}) === 0);
assert(`${PLATFORM}: no-dac-override excused`, failing("[needs:no-dac-override] root ignores 0400", {}) === 0);
assert(`${PLATFORM}: os= excused`, failing("[needs:os=windows] path semantics", {}) === 0);
assert(`${PLATFORM}: ipv6-loopback excused`, failing("IPv6 loopback (::1) is unavailable on this host [needs:ipv6-loopback]", {}) === 0);

console.log("\n--- several tags: every one must be excusable ---");
assert("tags: platform + unset optional engine excused", failing("[needs:os=linux] [needs:firebird]", {}) === 0);
assert("tags: platform + always-provisioned service fails", failing("[needs:os=linux] [needs:redis]", {}) === 1);
assert("tags: needsTags reads every tag in order",
  JSON.stringify(needsTags("a [needs:firebird] b [needs:absent-ext=odbc]")) === JSON.stringify(["firebird", "absent-ext=odbc"]));
assert("tags: isExcusedSkip on a bare reason is false", isExcusedSkip("redis down", {}) === false);

console.log("\n--- gate off: nothing fails ---");
assert("gate off: an untagged skip does not fail", failing("redis not reachable", {}, false) === 0);
assert("gate off: an always-provisioned tag does not fail", failing("[needs:mongo] down", {}, false) === 0);
const mixed = [skipLine("redis down"), "  PASS something", skipLine("[needs:firebird] unset")].join("\n");
assert("gate on: only the unexcused line of a mixed output fails",
  JSON.stringify(gateFailures(mixed, true, {})) === JSON.stringify(["SKIP redis down"]));

console.log(`\n==================================================`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`==================================================`);
process.exit(failed > 0 ? 1 : 0);
