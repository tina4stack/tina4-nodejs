/**
 * Browser-open gate (ADR-0070) - the Node runner for
 * tina4-documentation/plan/v3/fixtures/browser_open_contract.json
 * (vendored byte for byte in test/fixtures/).
 *
 * Every decision_table row is fed to the REAL gate, shouldOpenBrowser() in
 * server.ts, the function startServer() calls. The environment is set for
 * real: the row's variables go into process.env, its .env lines are written to
 * a real file and loaded with the framework's own loadEnv() (process
 * environment first, as the ADR requires), and development mode is resolved
 * from TINA4_DEBUG with isTruthy(), exactly as startServer() resolves it. No
 * doubles. test/browserOpenGate.test.ts proves the same gate end to end on a
 * booted server.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldOpenBrowser, CI_ENVIRONMENT_VARIABLES, CI_NOT_SET_VALUES } from "../packages/core/src/server.ts";
import { loadEnv, isTruthy } from "../packages/core/src/dotenv.ts";

interface Row {
  name: string;
  mode: "development" | "production";
  env: Record<string, string>;
  dotenv?: Record<string, string>;
  flags: string[];
  opens: boolean;
}

const contract = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "browser_open_contract.json"), "utf8")) as {
  decision_table: Row[];
  truthy: string[];
  ci_env_vars: string[];
  ci_not_set_values: string[];
};

// Every variable the gate reads, cleared before each row and restored after.
const GATE_VARIABLES = ["TINA4_NO_BROWSER", "TINA4_DEBUG", "TINA4_PRODUCTION", ...CI_ENVIRONMENT_VARIABLES];
const saved = new Map(GATE_VARIABLES.map((name) => [name, process.env[name]]));
const dirs: string[] = [];

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function decide(row: Row): boolean {
  for (const name of GATE_VARIABLES) delete process.env[name];
  // The mode, the way a framework server resolves it: TINA4_DEBUG, read with
  // the framework's own truthy helper. --production is the CLI's spelling of
  // the same production mode.
  process.env.TINA4_DEBUG = row.mode === "development" ? "true" : "false";
  Object.assign(process.env, row.env);
  if (row.dotenv) {
    const dir = mkdtempSync(join(tmpdir(), "tina4-browser-contract-"));
    dirs.push(dir);
    const file = join(dir, ".env");
    writeFileSync(file, Object.entries(row.dotenv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
    loadEnv(file);
  }
  const isDevelopment = isTruthy(process.env.TINA4_DEBUG);
  return shouldOpenBrowser(isDevelopment, row.flags.includes("--no-browser"));
}

describe("browser_open_contract.json decision_table", () => {
  it("the gate reads exactly the fixture's lists", () => {
    // Element for element, in order: a variable or value added to one side
    // and not the other is a parity break.
    expect(CI_ENVIRONMENT_VARIABLES).toEqual(contract.ci_env_vars);
    expect(CI_NOT_SET_VALUES).toEqual(contract.ci_not_set_values);
    expect(contract.truthy).toEqual(["true", "1", "yes", "on"]);
    for (const value of contract.truthy) expect(isTruthy(` ${value.toUpperCase()} `), value).toBe(true);
    expect(contract.decision_table).toHaveLength(85);
  });

  for (const row of contract.decision_table) {
    it(row.name, () => {
      expect(decide(row), `${row.name}: env ${JSON.stringify(row.env)} dotenv ${JSON.stringify(row.dotenv ?? {})} flags ${row.flags}`).toBe(row.opens);
    });
  }

  it("TINA4_PRODUCTION never counts as development", () => {
    expect(decide({ name: "prod", mode: "development", env: { TINA4_PRODUCTION: "true" }, flags: [], opens: false })).toBe(false);
  });
});
