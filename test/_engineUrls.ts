/**
 * The connection URL for a lab database engine, from its canonical coordinate
 * (ADR-0038, test/fixtures/test_env_contract.json - the same names the
 * require-services gate reads), falling back to the lab/CI default.
 *
 * The URL is handed to the framework's own URL parsing whole; nothing here
 * assembles one from username/password parts.
 */
const COORDINATES: Record<string, [string, string]> = {
  postgres: ["TINA4_TEST_PG_URL", "postgres://tina4:tina4@127.0.0.1:55432/tina4_node"],
  mysql: ["TINA4_TEST_MYSQL_URL", "mysql://tina4:tina4@127.0.0.1:3306/tina4_test"],
  mssql: ["TINA4_TEST_MSSQL_URL", "mssql://sa:TinaSQL123!Secure@127.0.0.1:1433/tina4_test"],
};

export function labEngineUrl(engine: "postgres" | "mysql" | "mssql"): string {
  const [name, fallback] = COORDINATES[engine];
  const configured = (process.env[name] ?? "").trim();
  return configured === "" ? fallback : configured;
}

/** Host and port of a URL, for a reachability probe (never the credentials). */
export function hostAndPort(url: string, defaultPort: number): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || defaultPort) };
}
