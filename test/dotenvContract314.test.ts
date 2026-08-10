/**
 * Fail-closed runner for the audited Tina4 3.14 DotEnv contract.
 *
 * Every fixture case requires exactly one real behavioural executor. Missing
 * executors fail; they are never skipped or marked pending.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type ContractCase = {
  id: string;
  witness: string;
  [key: string]: unknown;
};

type Executor = (contractCase: ContractCase) => void | Promise<void>;

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "fixtures", "dotenv_corpus.json"), "utf-8"),
) as { contract_3_14: { cases: ContractCase[] } };
const cases = fixture.contract_3_14.cases;

// Implementation work registers one real-filesystem/process-environment
// executor per case. Empty now means the completed audit turns the suite red
// until Feature 1 is implemented.
const executors: Record<string, Executor> = {};

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
    fail++;
  }
}

console.log("=== DotEnv contract_3_14 ===\n");

const ids = cases.map((item) => item.id);
const witnesses = cases.map((item) => item.witness);
assert("discovers exactly 46 cases", ids.length === 46, `got ${ids.length}`);
assert("case IDs are unique", new Set(ids).size === ids.length);
assert("mutation witnesses are unique", new Set(witnesses).size === witnesses.length);
assert(
  "executor registry has no unknown cases",
  Object.keys(executors).every((id) => ids.includes(id)),
);

for (const contractCase of cases) {
  const executor = executors[contractCase.id];
  if (executor === undefined) {
    assert(
      contractCase.id,
      false,
      `contract_3_14 executor not implemented; witness=${contractCase.witness}`,
    );
    continue;
  }

  try {
    await executor(contractCase);
    assert(contractCase.id, true);
  } catch (error) {
    assert(
      contractCase.id,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
