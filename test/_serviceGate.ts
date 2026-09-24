/**
 * Real-service test gate - the same rule in all four frameworks.
 *
 * Under TINA4_REQUIRE_SERVICES a skip PASSES only when its reason carries a
 * machine-readable `[needs:X]` tag AND X is excusable in this run. There is no
 * phrase matching: the old keyword + "not reachable" matcher missed reasons
 * worded "no reachable ..." or "... unavailable", and those skipped green -
 * ghost tests under a flag that promised they would fail.
 *
 *   - X is an OPTIONAL engine with a coordinate env var (firebird, postgres,
 *     postgis, mysql, mssql, swoole, oidc, neo4j, memgraph, arango, ultipa): excused
 *     ONLY while that coordinate is unset in this run. A CI job that never
 *     promised the engine stays green; the lab, which sets every coordinate,
 *     fails.
 *   - X is an ALWAYS-provisioned service (mongo, redis, valkey, memcached,
 *     rabbitmq, kafka, mqtt, smtp, imap, s3): never excused.
 *   - Any other X (absent-ext=..., no-dac-override, os=..., runtime=...) is a
 *     platform exclusion: always excused.
 *   - An untagged skip FAILS.
 *
 * The runner (test/run-all.ts) captures each test file's stdout and runs every
 * SKIP line through gateFailures() - the "central gate" approach of the Python
 * conftest hook.
 */

/** Optional engines and the coordinate env vars that promise them. */
const OPTIONAL_ENGINE_COORDINATES: Record<string, string[]> = {
  firebird: ["TINA4_TEST_FIREBIRD_URL"],
  // Only the canonical name (ADR-0038, test/fixtures/test_env_contract.json):
  // the contract's "or TINA4_TEST_POSTGRES_URL" alias is non-canonical here.
  postgres: ["TINA4_TEST_PG_URL"],
  postgis: ["TINA4_TEST_POSTGIS_URL"],
  mysql: ["TINA4_TEST_MYSQL_URL"],
  mssql: ["TINA4_TEST_MSSQL_URL"],
  swoole: ["TINA4_TEST_SWOOLE"],
  oidc: ["TINA4_TEST_OIDC_ISSUER"],
  neo4j: ["TINA4_TEST_NEO4J_URL"],
  memgraph: ["TINA4_TEST_MEMGRAPH_URL"],
  arango: ["TINA4_TEST_ARANGO_URL"],
  ultipa: ["TINA4_TEST_ULTIPA_URL"],
};

/** Services every provisioned environment stands up: a skip is never excused. */
const ALWAYS_PROVISIONED = new Set([
  "mongo", "redis", "valkey", "memcached", "rabbitmq", "kafka", "mqtt", "smtp", "imap", "s3",
]);

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function requireServices(): boolean {
  return isTruthy(process.env.TINA4_REQUIRE_SERVICES);
}

/** The `[needs:X]` tags in a skip reason, in order. */
export function needsTags(reason: string): string[] {
  return [...(reason || "").matchAll(/\[needs:([^\]]+)\]/g)].map((m) => m[1].trim());
}

/**
 * Is this skip excused under TINA4_REQUIRE_SERVICES? Only a tagged reason can
 * be, and only when EVERY tag is excusable in this environment (see header).
 */
export function isExcusedSkip(reason: string, env: Record<string, string | undefined> = process.env): boolean {
  const tags = needsTags(reason);
  if (tags.length === 0) return false;
  return tags.every((tag) => {
    const coordinates = OPTIONAL_ENGINE_COORDINATES[tag];
    if (coordinates) return coordinates.every((name) => (env[name] ?? "").trim() === "");
    if (ALWAYS_PROVISIONED.has(tag)) return false;
    return true;
  });
}

/**
 * Every SKIP line in a test file's stdout, ANSI-stripped and trimmed.
 *
 * The runner discards a passing file's captured stdout, so before this existed
 * a skip inside a green file was invisible: `Grand Total` reported passed and
 * failed only, and grepping a run log for SKIP returned NOTHING even when tests
 * had skipped. Python prints "N skipped", PHPUnit "Skipped: N" and RSpec
 * "N pending" — Node reported no skip number at all, so its skip count could
 * not be measured, let alone driven to zero.
 *
 * A skip line in any of the test files contains the bare token "SKIP"; the
 * files use several shapes around it (em dash, hyphen, parenthesised, bare),
 * so the token is the only reliable invariant.
 */
export function findSkipLines(output: string): string[] {
  const hits: string[] = [];
  for (const rawLine of (output || "").split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    if (!/\bSKIP\b/.test(line)) continue;
    hits.push(line.trim());
  }
  return hits;
}

/**
 * The SKIP lines in a test file's stdout that FAIL the run. Empty when the gate
 * is off - the flag decides whether skips fail, never whether they are counted.
 */
export function gateFailures(
  output: string,
  gateOn: boolean,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!gateOn) return [];
  return findSkipLines(output).filter((reason) => !isExcusedSkip(reason, env));
}
