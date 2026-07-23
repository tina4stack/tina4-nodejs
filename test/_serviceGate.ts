/**
 * Real-service test gate — mirrors tina4-python/tests/conftest.py.
 *
 * When TINA4_REQUIRE_SERVICES is truthy, a test that SKIPPED because a
 * PROVISIONED service (or its client library) was unavailable is treated as a
 * hard FAILURE. CI stands up PostgreSQL, Redis, Valkey, Memcached, MongoDB,
 * RabbitMQ, and Kafka and sets every TINA4_TEST_* URL, so these integration
 * tests must RUN — a service-unavailable skip means the service or driver
 * silently went missing (the exact gap that let the migration / queue bugs
 * ship green).
 *
 * MySQL / MSSQL / SQL Server joined the provisioned set in #262 (CI stands up
 * mysql:8 + mssql/server:2022), so their reachability / driver skips now fail
 * the gate too — they are in SERVICE_KEYWORDS below. Firebird is still NOT
 * provisioned, so its skips must stay green and its keyword stays EXCLUDED.
 *
 * The runner (test/run-all.ts) captures each test file's stdout and runs every
 * SKIP line through this matcher — so individual test files need no edits. This
 * is the same "central gate" approach as the Python conftest hook.
 */

// Provisioned real services + their Node client libraries. A skip reason that
// names one of these AND signals unavailability is a hard failure under the flag.
const SERVICE_KEYWORDS = [
  "postgres",
  "postgresql",
  "mysql", // also matches "mysql2" (#262, provisioned mysql:8)
  "mssql",
  "sqlserver", // MSSQL / SQL Server (#262, provisioned mssql/server:2022)
  "tedious", // the Node MSSQL client library
  "redis",
  "valkey",
  "memcached",
  "mongo", // also matches "mongodb"
  "rabbit",
  "amqp",
  "kafka",
  "mqtt", // Mosquitto (+ EMQX) for the MQTT tests; also matches "mqtts"
  "mosquitto",
];

// Hints that a skip was caused by the service/driver being unavailable (rather
// than e.g. an intentional "this needs a running X server" placeholder skip or
// a "package is installed" branch).
const UNAVAILABLE_HINTS = [
  "not reachable",
  "unreachable",
  "not running",
  "not set",
  "not installed",
  "could not connect",
  "not available",
  "refused",
];

// Service keywords that are NOT provisioned in CI — their skips stay green even
// when they appear alongside an unavailable hint. Firebird is the only engine
// left here (MySQL/MSSQL became provisioned in #262 and moved to SERVICE_KEYWORDS).
const EXCLUDED_KEYWORDS = ["firebird"];

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function requireServices(): boolean {
  return isTruthy(process.env.TINA4_REQUIRE_SERVICES);
}

/**
 * Does this skip reason describe a PROVISIONED service that was unavailable?
 * Excludes the non-provisioned engines (mysql/mssql/sqlserver/firebird).
 */
export function isProvisionedServiceSkip(reason: string): boolean {
  const low = (reason || "").toLowerCase();
  if (EXCLUDED_KEYWORDS.some((k) => low.includes(k))) return false;
  return (
    SERVICE_KEYWORDS.some((k) => low.includes(k)) &&
    UNAVAILABLE_HINTS.some((h) => low.includes(h))
  );
}

/**
 * Scan a test file's full stdout for SKIP lines that name an unavailable
 * provisioned service. Returns the offending reason strings (ANSI-stripped).
 */
export function findProvisionedServiceSkips(output: string): string[] {
  const hits: string[] = [];
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(ANSI_RE, "");
    // A skip line in any of the test files contains the token "SKIP".
    if (!/\bSKIP\b/.test(line)) continue;
    if (isProvisionedServiceSkip(line)) hits.push(line.trim());
  }
  return hits;
}
