/**
 * Real tests for the MCP `migration_create` tool's ADR-0063 envelope
 * unification (3.13.121).
 * Run with: npx tsx test/mcpMigrationCreateEnvelope.test.ts
 *
 * Before 3.13.121 the MCP tool wrote a single sequential file
 * `000001_<desc>.sql` with no envelope, no `-- tina4:edit` markers, no
 * `.down.sql` pair, no `edit_hints[]` or `next[]` — two spellings for one
 * operation (CLI vs MCP), two shapes for the same "created a migration"
 * event. 3.13.121 delegates the MCP tool to the CLI's canonical
 * `generateProgrammatic("migration", …)` so a single generator drives both
 * surfaces.
 *
 * The contract this file pins:
 *   - The MCP tool returns `{ok: true, created, resolution}` (the pre-3.13.121
 *     `{created}` contract is preserved as a subset).
 *   - `created` matches /^\d{14}_[a-z0-9_]+\.sql$/ — a 14-digit timestamp,
 *     never the old 6-digit sequential shape.
 *   - `resolution` is a `generate_v1_1` envelope: `command="generate"`,
 *     `target="migration"`, populated `resolution.edit_hints[]` (SQL markers
 *     land on both the up + down files), populated `resolution.next[]`
 *     (curated `npx tina4nodejs migrate` step, etc).
 *   - Filesystem: exactly TWO SQL files land on disk under migrations/
 *     (`<ts>_<slug>.sql` UP + `<ts>_<slug>.down.sql` DOWN), matching what
 *     `tina4 migrate:create` writes.
 *   - Envelope parity: the shape from the MCP tool matches
 *     `tina4nodejs migrate:create "…" --json --dry-run` (both routes speak
 *     the same envelope after the unify).
 *   - Duplicate-slug guard: a second call for the same slug returns
 *     `{ok: false, error, existing[]}` rather than layering a second
 *     timestamp under the same intent.
 *   - MUTATION GATE: temporarily swap `mcp.ts` back to the pre-3.13.121 body
 *     (sequential 000001, no envelope), spawn a subprocess that calls the
 *     tool, assert the envelope is ABSENT — proves the assertions really
 *     catch a regression rather than green-tick over a fixture.
 *
 * No mocks. In-process McpServer + real `tools/call` JSON-RPC dispatch, real
 * mkdtemp project dir, real SQL files land on disk, real subprocess for the
 * parity + mutation gates.
 */
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer, registerDevTools } from "../packages/core/src/mcp.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const binPath = resolve(repoRoot, "packages/cli/src/bin.ts");
const mcpTsPath = resolve(repoRoot, "packages/core/src/mcp.ts");

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

/** Timestamped SQL filename shape — 14 digits (YYYYMMDDHHMMSS), then _slug.sql. */
const TIMESTAMPED_SQL_RE = /^\d{14}_[a-z0-9_]+\.sql$/;
/** The OLD sequential shape the pre-3.13.121 MCP tool emitted — must be gone. */
const SEQUENTIAL_SQL_RE = /^\d{6}_[a-z0-9_]+\.sql$/;

/** Spawn a fresh subprocess to run the tina4nodejs CLI in a temp cwd. */
function runCli(
  cwd: string,
  argv: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const res = spawnSync("npx", ["tsx", binPath, ...argv], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 90_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? -1,
  };
}

/**
 * Spawn a fresh Node subprocess that invokes the MCP `migration_create` tool
 * against the given project cwd. Used for the mutation gate — a subprocess is
 * mandatory there because tsx caches ESM modules in-process, so a source-file
 * swap on the parent has no effect on the parent's already-loaded MCP module.
 *
 * Uses a temp `.mts` script rather than `tsx --eval` because --eval runs the
 * source in CJS format, which forbids top-level await (needed for handleMessage
 * which is async).
 */
function invokeMigrationCreateViaSubprocess(
  cwd: string,
  description: string,
): { ok: boolean; parsed: Record<string, unknown> | null; stdout: string; stderr: string; exitCode: number } {
  const mcpImportPath = resolve(repoRoot, "packages/core/src/mcp.ts").replace(/\\/g, "/");
  const script = `import { McpServer, registerDevTools } from ${JSON.stringify(mcpImportPath)};
process.env.TINA4_DEBUG = "true";
const server = new McpServer("/mcp-mutation-gate", "Mutation Gate");
registerDevTools(server);
const raw = await server.handleMessage({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "migration_create", arguments: { description: ${JSON.stringify(description)} } },
});
const parsed = raw ? JSON.parse(raw) : null;
const text = parsed?.result?.content?.[0]?.text ?? "";
let value = null;
try { value = JSON.parse(text); } catch { value = text; }
process.stdout.write(JSON.stringify({ rpc: parsed, value }));
`;
  const scriptDir = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-mut-script-"));
  const scriptPath = join(scriptDir, "gate.mts");
  writeFileSync(scriptPath, script, "utf-8");
  try {
    const res = spawnSync("npx", ["tsx", scriptPath], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 90_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const stdout = res.stdout ?? "";
    const stderr = res.stderr ?? "";
    const exitCode = res.status ?? -1;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { ok: exitCode === 0 && parsed !== null, parsed, stdout, stderr, exitCode };
  } finally {
    rmSync(scriptDir, { recursive: true, force: true });
  }
}

/** In-process McpServer helper: call one tool, parse the JSON payload out. */
async function callTool(
  proj: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ rpcError: unknown; value: Record<string, unknown> | string | null; raw: string }> {
  const origCwd = process.cwd();
  process.chdir(proj);
  try {
    const server = new McpServer("/mcp-migration-create-test", "Envelope Test");
    registerDevTools(server);
    const raw = await server.handleMessage({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e9),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed.error) return { rpcError: parsed.error, value: null, raw: "" };
    const text: string = parsed.result?.content?.[0]?.text ?? "";
    let value: Record<string, unknown> | string | null = text;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      /* plain string result */
    }
    return { rpcError: null, value, raw: text };
  } finally {
    process.chdir(origCwd);
  }
}

process.env.TINA4_DEBUG = "true";

async function main(): Promise<void> {
  console.log("=== MCP migration_create envelope (ADR-0063, 3.13.121) ===\n");

  // ── 1. Positive envelope: in-process tools/call → generate_v1_1 shape ──
  console.log("--- 1. positive: MCP tool returns the generate_v1_1 envelope ---");
  {
    const proj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-pos-"));
    try {
      const res = await callTool(proj, "migration_create", { description: "add users table" });
      assert("no JSON-RPC error", res.rpcError === null, JSON.stringify(res.rpcError));
      const value = res.value as Record<string, unknown> | null;
      assert("tool returned an object", value !== null && typeof value === "object");
      if (!value || typeof value !== "object") return;

      assert("ok === true", value.ok === true, `value=${JSON.stringify(value)}`);
      assert("created is a string", typeof value.created === "string");
      const created = value.created as string;

      // Filename shape — the whole point of the unify.
      assert(
        `created matches YYYYMMDDHHMMSS_<slug>.sql (got ${created})`,
        TIMESTAMPED_SQL_RE.test(created),
      );
      assert(
        `created does NOT match the OLD 6-digit sequential shape (got ${created})`,
        !SEQUENTIAL_SQL_RE.test(created),
      );

      const resolution = value.resolution as Record<string, unknown> | undefined;
      assert("resolution envelope present", resolution !== undefined && typeof resolution === "object");
      if (!resolution || typeof resolution !== "object") return;

      assert("envelope command === 'generate'", resolution.command === "generate", `command=${resolution.command}`);
      assert("envelope target === 'migration'", resolution.target === "migration", `target=${resolution.target}`);
      assert("envelope dry_run === false (wet run)", resolution.dry_run === false, `dry_run=${resolution.dry_run}`);
      assert(
        "envelope actions_taken contains real writes",
        Array.isArray(resolution.actions_taken) && (resolution.actions_taken as unknown[]).length >= 2,
        `actions_taken=${JSON.stringify(resolution.actions_taken)}`,
      );

      const body = resolution.resolution as Record<string, unknown> | undefined;
      assert("resolution body present", body !== undefined && typeof body === "object");
      if (!body || typeof body !== "object") return;

      // Populated edit_hints[] (SQL `-- tina4:edit` markers land on up + down).
      assert(
        "resolution.edit_hints is a non-empty array",
        Array.isArray(body.edit_hints) && (body.edit_hints as unknown[]).length > 0,
        `edit_hints=${JSON.stringify(body.edit_hints)}`,
      );
      const hints = body.edit_hints as Array<Record<string, unknown>>;
      for (const h of hints) {
        assert(`edit_hint has file/line/label (got ${JSON.stringify(h)})`,
          typeof h.file === "string" && typeof h.line === "number" && typeof h.label === "string");
      }
      const hintFiles = hints.map((h) => h.file as string);
      assert(
        "edit_hints cover BOTH the .sql and the .down.sql file",
        hintFiles.some((f) => /\.sql$/.test(f) && !/\.down\.sql$/.test(f))
          && hintFiles.some((f) => /\.down\.sql$/.test(f)),
        `files=${JSON.stringify(hintFiles)}`,
      );

      // Populated next[] (curated next-steps).
      assert(
        "resolution.next is a non-empty array",
        Array.isArray(body.next) && (body.next as unknown[]).length > 0,
        `next=${JSON.stringify(body.next)}`,
      );
      assert(
        "resolution.next mentions `migrate` (curated migration step)",
        Array.isArray(body.next) && (body.next as string[]).some((s) => /\bmigrate\b/.test(s)),
        `next=${JSON.stringify(body.next)}`,
      );

      // Files landed on disk in the timestamped shape.
      const migrations = readdirSync(join(proj, "migrations")).sort();
      assert(
        "exactly two SQL files (up + down) landed on disk",
        migrations.filter((f) => f.endsWith(".sql")).length === 2,
        `files=${JSON.stringify(migrations)}`,
      );
      const up = migrations.find((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
      const down = migrations.find((f) => f.endsWith(".down.sql"));
      assert("up file matches timestamp shape", !!up && TIMESTAMPED_SQL_RE.test(up), `up=${up}`);
      assert("down file exists", !!down, `down=${down}`);
      if (up) {
        const body = readFileSync(join(proj, "migrations", up), "utf-8");
        assert("up file carries a SQL edit-hint marker", /-- tina4:edit/.test(body));
      }
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ── 2. Envelope parity with the CLI's migrate:create --json --dry-run ──
  console.log("\n--- 2. parity: MCP envelope matches `migrate:create --json --dry-run` ---");
  {
    const proj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-parity-"));
    try {
      // CLI: run migrate:create in --json --dry-run so no files touch disk.
      const cli = runCli(proj, ["migrate:create", "add users table", "--json", "--dry-run"]);
      assert("CLI subprocess exited 0", cli.exitCode === 0,
        `exit=${cli.exitCode} stderr=${cli.stderr.slice(0, 400)}`);
      let cliEnv: Record<string, unknown> | null = null;
      try { cliEnv = JSON.parse(cli.stdout) as Record<string, unknown>; } catch { /* left null */ }
      assert("CLI stdout parses as JSON envelope", cliEnv !== null, `stdout=${cli.stdout.slice(0, 400)}`);

      // MCP: fresh temp dir so the wet run doesn't collide.
      const mcpProj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-parity-mcp-"));
      try {
        const mcp = await callTool(mcpProj, "migration_create", { description: "add users table" });
        const mcpVal = mcp.value as Record<string, unknown> | null;
        const mcpEnv = mcpVal?.resolution as Record<string, unknown> | undefined;
        assert("MCP envelope present", mcpEnv !== undefined);

        if (mcpEnv && cliEnv) {
          assert("both envelopes: command === 'generate'",
            mcpEnv.command === cliEnv.command && mcpEnv.command === "generate",
            `mcp=${mcpEnv.command} cli=${cliEnv.command}`);
          assert("both envelopes: target === 'migration'",
            mcpEnv.target === cliEnv.target && mcpEnv.target === "migration",
            `mcp=${mcpEnv.target} cli=${cliEnv.target}`);

          const mcpBody = mcpEnv.resolution as Record<string, unknown>;
          const cliBody = cliEnv.resolution as Record<string, unknown>;
          // Both bodies share the same set of populated envelope keys (order-
          // insensitive). dry_run + actions_taken differ (wet vs dry) but the
          // resolution SHAPE — the discoverable keys an agent uses to steer —
          // is identical after the unify.
          const relevantKeys = new Set<string>();
          for (const k of Object.keys(mcpBody)) relevantKeys.add(k);
          for (const k of Object.keys(cliBody)) relevantKeys.add(k);
          for (const k of ["edit_hints", "next", "migration_path", "table_name", "transformations", "test_paths", "file_path"]) {
            if (relevantKeys.has(k)) {
              assert(`both bodies expose "${k}"`,
                Object.prototype.hasOwnProperty.call(mcpBody, k)
                  === Object.prototype.hasOwnProperty.call(cliBody, k),
                `mcp=${Object.prototype.hasOwnProperty.call(mcpBody, k)} cli=${Object.prototype.hasOwnProperty.call(cliBody, k)}`);
            }
          }
        }
      } finally {
        rmSync(mcpProj, { recursive: true, force: true });
      }
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ── 3. Duplicate-slug guard ─────────────────────────────────────
  console.log("\n--- 3. duplicate-slug guard ---");
  {
    const proj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-dup-"));
    try {
      const first = await callTool(proj, "migration_create", { description: "add products" });
      const firstVal = first.value as Record<string, unknown> | null;
      assert("first migration_create ok", firstVal?.ok === true, JSON.stringify(firstVal));

      const second = await callTool(proj, "migration_create", { description: "add products" });
      const secondVal = second.value as Record<string, unknown> | null;
      assert("duplicate-slug returns ok:false",
        secondVal?.ok === false,
        JSON.stringify(secondVal));
      assert("duplicate-slug error mentions 'exists'",
        typeof secondVal?.error === "string" && /exists/i.test(secondVal.error as string),
        JSON.stringify(secondVal));
      assert("duplicate-slug reports the existing file(s)",
        Array.isArray(secondVal?.existing) && (secondVal.existing as unknown[]).length > 0,
        JSON.stringify(secondVal));
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ── 4. Empty-description guard ──────────────────────────────────
  console.log("\n--- 4. empty-description guard ---");
  {
    const proj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-empty-"));
    try {
      const res = await callTool(proj, "migration_create", { description: "" });
      const val = res.value as Record<string, unknown> | null;
      assert("empty description returns ok:false",
        val?.ok === false, JSON.stringify(val));
      assert("empty description error mentions 'required'",
        typeof val?.error === "string" && /required/i.test(val.error as string),
        JSON.stringify(val));
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  }

  // ── 5. MUTATION GATE — swap mcp.ts back to the pre-3.13.121 body ─
  //    and prove the positive assertion FAILS. Restore. Proves this
  //    test really catches a regression (rather than green-ticking a
  //    fixture). A subprocess is mandatory: tsx caches modules
  //    in-process, so a source swap on the parent has no effect on
  //    the parent's already-loaded MCP.
  console.log("\n--- 5. MUTATION GATE — pre-3.13.121 body must FAIL these assertions ---");
  {
    const proj = mkdtempSync(join(tmpdir(), "tina4-mcp-mig-mut-"));
    const originalMcp = readFileSync(mcpTsPath, "utf-8");
    try {
      // The pre-3.13.121 body: sequential 000001 numbering, no envelope,
      // returns { created } only (no ok, no resolution). Kept verbatim from
      // the diff in packages/core/src/mcp.ts before this commit.
      const oldBody = `  server.registerTool(
    "migration_create",
    (args) => {
      const desc = (args.description as string).replace(/\\s+/g, "_").toLowerCase();
      const migrationsDir = path.join(projectRoot, "migrations");
      if (!fs.existsSync(migrationsDir)) {
        fs.mkdirSync(migrationsDir, { recursive: true });
      }
      const existing = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
      const nextNum = String(existing.length + 1).padStart(6, "0");
      const filename = \`\${nextNum}_\${desc}.sql\`;
      fs.writeFileSync(path.join(migrationsDir, filename), \`-- Migration: \${args.description}\\n\`, "utf-8");
      return { created: filename };
    },
    "Create a new migration file",
    schemaFromParams([{ name: "description", type: "string" }]),
  );`;

      // Find the CURRENT block (a robust anchor: from registerTool("migration_create" to the matching schemaFromParams line).
      const current = originalMcp;
      const startMarker = 'server.registerTool(\n    "migration_create",';
      const startIdx = current.indexOf(startMarker);
      assert("mutation gate can locate the migration_create block", startIdx >= 0);
      if (startIdx < 0) return;
      // Find the CLOSING `);` for THIS registerTool call — a `schemaFromParams([{ name: "description"` line
      // is unique to migration_create in mcp.ts, and the `);` two lines after it is the block terminator.
      const paramsMarker = 'schemaFromParams([{ name: "description", type: "string" }]),\n  );';
      const paramsIdx = current.indexOf(paramsMarker, startIdx);
      assert("mutation gate can locate the block's terminator", paramsIdx >= 0);
      if (paramsIdx < 0) return;
      const endIdx = paramsIdx + paramsMarker.length;

      const mutated = current.slice(0, startIdx) + oldBody.trimStart() + current.slice(endIdx);
      writeFileSync(mcpTsPath, mutated, "utf-8");

      // Run the MCP tool in a fresh subprocess (fresh tsx cache).
      const sub = invokeMigrationCreateViaSubprocess(proj, "mutation gate");
      assert("mutation-gate subprocess exited 0", sub.ok,
        `exit=${sub.exitCode} stderr=${sub.stderr.slice(0, 400)}`);
      const value = (sub.parsed as any)?.value as Record<string, unknown> | undefined;
      // The OLD body returns { created } only — no ok, no resolution.
      assert("mutated tool returns { created }", typeof value?.created === "string",
        JSON.stringify(value));
      // These four assertions are the ones the positive test asserts as TRUE
      // — under the OLD body they MUST be false, proving the positive test
      // really pinpoints the fix and not the environment.
      const oldCreated = value?.created as string;
      assert("MUTATION: filename is now SEQUENTIAL 000001-shape (positive test would FAIL)",
        SEQUENTIAL_SQL_RE.test(oldCreated), `oldCreated=${oldCreated}`);
      assert("MUTATION: filename does NOT match the TIMESTAMPED shape (positive test would FAIL)",
        !TIMESTAMPED_SQL_RE.test(oldCreated), `oldCreated=${oldCreated}`);
      assert("MUTATION: no `ok` field (positive test would FAIL)",
        value?.ok === undefined, JSON.stringify(value));
      assert("MUTATION: no `resolution` envelope (positive test would FAIL)",
        value?.resolution === undefined, JSON.stringify(value));
    } finally {
      // ALWAYS restore, even on test failure — a lingering mutated mcp.ts
      // would break every subsequent MCP test.
      writeFileSync(mcpTsPath, originalMcp, "utf-8");
      rmSync(proj, { recursive: true, force: true });
    }
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
