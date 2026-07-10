/**
 * Meta-test: every code-producing generator co-emits a REAL, green test.
 * Run with: npx tsx test/cliGenerateCoemits.test.ts
 *
 * Port of tina4-python/tests/test_cli_generate_coemits.py.
 *
 * For each generator we scaffold into a fresh temp project via the ACTUAL
 * `tina4nodejs generate <what> <name>` command (a real subprocess through the
 * real CLI entry point, packages/cli/src/bin.ts), then RUN the co-emitted
 * `*.test.ts` with real tsx in a real subprocess and assert it passes (exit 0).
 * No mocks anywhere: real generate, real tsx run of the emitted file, real
 * SQLite / TestClient / Router / MiddlewareChain / ServiceRunner / Queue / event
 * bus underneath.
 *
 * The temp project MUST live inside the repo tree so the emitted files'
 * `import … from "tina4-nodejs"[/orm]` self-resolve via the root package's
 * exports map (Node's self-reference) — they do NOT resolve from an arbitrary
 * /tmp dir. This mirrors test/cli.test.ts's in-repo scaffolding requirement.
 *
 * This proves each co-emitted test is (a) actually written next to the code and
 * (b) green on generation — a scaffolded test that fails on creation is bad DX.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const cliBin = join(repoRoot, "packages/cli/src/bin.ts");
const baseDir = join(repoRoot, `.tmp_coemit_${process.pid}`);

// Child env: drop TINA4_API_KEY so the real auth gate behaves deterministically
// (a tokenless write is a clean 401), mirroring the Python meta-test's env.pop.
const childEnv = { ...process.env };
delete childEnv.TINA4_API_KEY;

/** Run `tina4nodejs <args>` in `cwd` through the real CLI; require success. */
function runCli(cwd: string, args: string[]): void {
  execFileSync(tsxBin, [cliBin, ...args], {
    cwd, env: childEnv, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
}

/** Run a co-emitted `*.test.ts` with real tsx; return { ok, output }. */
function runEmittedTest(cwd: string, testRel: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync(tsxBin, [join(cwd, testRel)], {
      cwd, env: childEnv, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
    });
    return { ok: /(\d+) passed, 0 failed/.test(out), output: out };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

interface Case {
  id: string;
  pre: string[][];        // pre-generate commands (arg arrays)
  gen: string[];          // the generate command (arg array)
  test: string;           // the co-emitted test file, relative to the project
}

const CASES: Case[] = [
  { id: "model", pre: [],
    gen: ["generate", "model", "Product", "--fields", "name:string,price:float"],
    test: "tests/product_model.test.ts" },
  { id: "route_with_model", pre: [["generate", "model", "Product"]],
    gen: ["generate", "route", "products", "--model", "Product"],
    test: "tests/products.test.ts" },
  { id: "route_public", pre: [["generate", "model", "Widget"]],
    gen: ["generate", "route", "widgets", "--model", "Widget", "--public"],
    test: "tests/widgets.test.ts" },
  { id: "route_no_model", pre: [],
    gen: ["generate", "route", "notes"],
    test: "tests/notes.test.ts" },
  { id: "middleware", pre: [],
    gen: ["generate", "middleware", "AuthLog"],
    test: "tests/auth_log.test.ts" },
  { id: "service", pre: [],
    gen: ["generate", "service", "Reaper", "--every", "5m"],
    test: "tests/reaper.test.ts" },
  { id: "queue", pre: [],
    gen: ["generate", "queue", "order-emails"],
    test: "tests/order_emails.test.ts" },
  { id: "validator", pre: [],
    gen: ["generate", "validator", "CreateUser"],
    test: "tests/create_user.test.ts" },
  { id: "seeder", pre: [["generate", "model", "Product"]],
    gen: ["generate", "seeder", "Product"],
    test: "tests/product_seeder.test.ts" },
  { id: "websocket", pre: [],
    gen: ["generate", "websocket", "chat"],
    test: "tests/ws_chat.test.ts" },
  { id: "listener", pre: [],
    gen: ["generate", "listener", "user.created"],
    test: "tests/user_created.test.ts" },
  { id: "auth", pre: [],
    gen: ["generate", "auth"],
    test: "tests/auth.test.ts" },
  { id: "migration", pre: [],
    gen: ["generate", "migration", "create_widget", "--fields", "name:string"],
    test: "tests/widget_migration.test.ts" },
  { id: "crud", pre: [],
    gen: ["generate", "crud", "Trinket", "--fields", "name:string,qty:int"],
    test: "tests/trinkets.test.ts" },
];

console.log("=== CLI generator co-emit meta-tests (real generate → real tsx run) ===\n");

rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });

try {
  for (const c of CASES) {
    const caseDir = join(baseDir, c.id);
    mkdirSync(join(caseDir, "data"), { recursive: true });  // secure-gate tests use data/<db>
    try {
      for (const pre of c.pre) runCli(caseDir, pre);
      runCli(caseDir, c.gen);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      assert(`[${c.id}] generate succeeds`, false, `\n${(e.stdout ?? "") + (e.stderr ?? "")}`);
      continue;
    }
    assert(`[${c.id}] generator co-emits ${c.test}`, existsSync(join(caseDir, c.test)));
    if (!existsSync(join(caseDir, c.test))) continue;
    const { ok, output } = runEmittedTest(caseDir, c.test);
    assert(`[${c.id}] co-emitted ${c.test} passes on generation (real tsx, exit 0)`,
      ok, ok ? "" : `\n${output}`);
  }

  // form / view scaffold Frond templates (no logic), so they are EXEMPT from
  // co-emitting a test — assert they produce a .twig and NO test file.
  {
    const caseDir = join(baseDir, "form_view_exempt");
    mkdirSync(caseDir, { recursive: true });
    runCli(caseDir, ["generate", "form", "Product", "--fields", "name:string"]);
    runCli(caseDir, ["generate", "view", "Product", "--fields", "name:string"]);
    assert("form/view: form template created",
      existsSync(join(caseDir, "src/templates/forms/product.twig")));
    assert("form/view: view template created",
      existsSync(join(caseDir, "src/templates/pages/products.twig")));
    const testsDir = join(caseDir, "tests");
    const emitted = existsSync(testsDir) ? readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")) : [];
    assert("form/view: template-only generators emit NO test", emitted.length === 0,
      emitted.join(", "));
  }
} finally {
  rmSync(baseDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
