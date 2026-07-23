/**
 * Real tests for the client-owned commands the CLI reaches by DELEGATION.
 *
 * `doctor`, `setup` and `deploy` are owned by the Rust `tina4` client. This CLI
 * recognises them (the closed DELEGATED registry in packages/cli/src/bin.ts) and
 * runs the client with the same argv, propagating its exit code — so
 * `tina4nodejs doctor` behaves exactly like `tina4 doctor` without cloning the
 * client into four languages.
 *
 * NO MOCKS. Every case spawns the REAL CLI entrypoint as a child process. The
 * positive cases put a REAL executable named `tina4` on a real temp PATH and
 * assert the CLI actually ran it with the exact argv and propagated its exit
 * status — real process, real PATH resolution, real exit status. The negative
 * cases use a real PATH with no `tina4` on it at all.
 *
 * PATH is set explicitly (never inherited) because this monorepo's own
 * node_modules/.bin contains a workspace-only `tina4` alias that would otherwise
 * shadow whatever the test intends to resolve.
 *
 * Run with: npx tsx test/cliDelegatedCommands.test.ts
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMANDS,
  DELEGATED,
  CLIENT_BINARY,
  DELEGATION_GUARD_ENV,
  EXIT_CLIENT_UNAVAILABLE,
  EXIT_UNKNOWN_COMMAND,
  buildCommandManifest,
} from "../packages/cli/src/bin.ts";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`); }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodeBin = process.execPath;
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");
const cliEntry = join(repoRoot, "packages/cli/src/bin.ts");

let tmpRoot = "";
function freshTmp(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "tina4-delegated-"));
  return tmpRoot;
}
const argvFile = (): string => join(tmpRoot, "argv.txt");
const guardFile = (): string => join(tmpRoot, "guard.txt");
const recordedArgv = (): string[] =>
  existsSync(argvFile()) ? readFileSync(argvFile(), "utf-8").trimEnd().split("\n") : [];
const recordedGuard = (): string =>
  existsSync(guardFile()) ? readFileSync(guardFile(), "utf-8").trim() : "";
const clientWasInvoked = (): boolean => existsSync(guardFile());

/**
 * Run the REAL CLI entrypoint as a child with a fully controlled PATH.
 * `npx` is deliberately NOT used — it re-injects node_modules/.bin onto PATH.
 */
function runCli(args: string[], path: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...process.env as Record<string, string>, PATH: path };
  delete env[DELEGATION_GUARD_ENV];
  Object.assign(env, extraEnv);
  const res = spawnSync(nodeBin, ["--import", tsxLoader, cliEntry, ...args], {
    cwd: tmpRoot, env, encoding: "utf-8", timeout: 60_000,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? -1, output: (res.stdout ?? "") + (res.stderr ?? "") };
}

/** A real PATH directory that genuinely has NO `tina4` executable on it. */
function pathWithoutClient(): string {
  const dir = join(tmpRoot, "nobin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Install a REAL executable named `tina4` on a fresh temp PATH.
 *
 * It is a genuine program (not a test double standing in for one): a small shell
 * script that records the argv and guard variable it was invoked with, then exits
 * with `exitCode`. That is exactly the collaborator the delegation code has —
 * "whatever executable named tina4 is first on PATH" — so the case exercises the
 * real PATH lookup, real spawn and real exit-status propagation, with no
 * in-process substitution anywhere.
 */
function pathWithRealClient(exitCode = 0): string {
  const dir = join(tmpRoot, "clientbin");
  mkdirSync(dir, { recursive: true });
  const client = join(dir, CLIENT_BINARY);
  writeFileSync(client,
    "#!/bin/sh\n" +
    `for arg in "$@"; do printf "%s\\n" "$arg" >> "${argvFile()}"; done\n` +
    `printf "%s\\n" "$${DELEGATION_GUARD_ENV}" > "${guardFile()}"\n` +
    'echo "REAL-CLIENT-RAN $*"\n' +
    `exit ${exitCode}\n`);
  chmodSync(client, 0o755);
  return dir;
}

console.log("\n  CLI delegated client commands (doctor / setup / deploy)\n");

// ── The registry itself ──────────────────────────────────────────────

assert("DELEGATED declares exactly doctor, setup and deploy",
  JSON.stringify(Object.keys(DELEGATED)) === JSON.stringify(["doctor", "setup", "deploy"]),
  Object.keys(DELEGATED).join(","));

assert("DELEGATED never shadows a natively dispatched command",
  Object.keys(DELEGATED).every((n) => !(n in COMMANDS)));

assert("every delegated command has a summary",
  Object.values(DELEGATED).every((s) => typeof s.summary === "string" && s.summary.length > 0));

{
  const byName = Object.fromEntries(buildCommandManifest().commands.map((c) => [c.name, c]));
  assert("manifest lists every delegated command, flagged delegated",
    Object.keys(DELEGATED).every((n) => byName[n]?.delegated === true));
  assert("manifest never flags a native command as delegated",
    Object.keys(COMMANDS).every((n) => byName[n]?.delegated === undefined));
}

// ── Positive: delegation really reaches the client ───────────────────

{
  freshTmp();
  const { code, output } = runCli(["doctor"], pathWithRealClient(0));
  assert("doctor runs the client with the same argv",
    code === 0 && output.includes("REAL-CLIENT-RAN doctor")
      && JSON.stringify(recordedArgv()) === JSON.stringify(["doctor"]),
    `code=${code} argv=${JSON.stringify(recordedArgv())}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  freshTmp();
  const { code } = runCli(["deploy", "docker", "--force"], pathWithRealClient(0));
  assert("deploy passes its arguments and flags through unchanged",
    code === 0 && JSON.stringify(recordedArgv()) === JSON.stringify(["deploy", "docker", "--force"]),
    `code=${code} argv=${JSON.stringify(recordedArgv())}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  freshTmp();
  const { code } = runCli(["doctor"], pathWithRealClient(3));
  assert("the client's exit code is propagated, not swallowed", code === 3, `code=${code}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  freshTmp();
  runCli(["setup"], pathWithRealClient(0));
  assert("the loop guard is set on the child", recordedGuard() === "setup", recordedGuard());
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ── Negative: every failure path is loud, actionable and non-zero ────

{
  freshTmp();
  const { code, output } = runCli(["doctor"], pathWithoutClient());
  assert("a missing client names the command and how to install it",
    code === EXIT_CLIENT_UNAVAILABLE && output.includes("doctor")
      && output.includes("tina4 client") && output.includes("install.sh")
      && !output.includes("at Object."),
    `code=${code} output=${output.slice(0, 200)}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  // Otherwise a `tina4` that resolves back to a framework CLI would fork-bomb.
  freshTmp();
  const { code, output } = runCli(["doctor"], pathWithRealClient(0),
    { [DELEGATION_GUARD_ENV]: "doctor" });
  assert("the loop guard refuses to respawn and spawns nothing",
    code === EXIT_CLIENT_UNAVAILABLE && output.includes("Refusing to delegate")
      && !clientWasInvoked(),
    `code=${code} invoked=${clientWasInvoked()}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  // Regression lock-in: an unknown command must fail loudly, never exit 0.
  freshTmp();
  const { code, output } = runCli(["definitely-not-a-command"], pathWithoutClient());
  assert("an unknown command exits non-zero with a clear message",
    code === EXIT_UNKNOWN_COMMAND && output.includes("Unknown command: definitely-not-a-command"),
    `code=${code}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

{
  // Delegation is allow-listed — that is how a forward loop is prevented.
  freshTmp();
  const { code } = runCli(["not-a-real-command"], pathWithRealClient(0));
  assert("an unknown command is never forwarded to the client",
    code === EXIT_UNKNOWN_COMMAND && !clientWasInvoked(),
    `code=${code} invoked=${clientWasInvoked()}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ── Help tells the truth ─────────────────────────────────────────────

{
  freshTmp();
  const { code, output } = runCli(["help"], pathWithoutClient());
  assert("help lists the delegated commands in their own section",
    code === 0 && output.includes(`Delegated to the ${CLIENT_BINARY} client`)
      && Object.keys(DELEGATED).every((n) => output.includes(n)),
    `code=${code}`);
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
