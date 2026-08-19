/** Real-child regression contract for the read-only `tina4 routes` command. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${detail}`); }
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(repo, "test", "fixtures", "cli_routes_contract.json"), "utf-8"));
const invariants = new Map(fixture.invariants.map((item: { id: string }) => [item.id, item]));
const routePath = (invariants.get("canonical-route-is-listed") as { route_path: string }).route_path;
const markerName = (invariants.get("application-entrypoint-is-not-executed") as { marker_name: string }).marker_name;
const project = mkdtempSync(join(tmpdir(), "tina4-routes-safe-"));
try {
  const routes = join(project, "src", "routes");
  mkdirSync(routes, { recursive: true });
  const probeDir = join(routes, routePath.replace(/^\//, ""));
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(
    join(probeDir, "get.ts"),
    "export default async function () { return { ok: true }; }\n",
  );
  const marker = join(project, markerName);
  writeFileSync(
    join(project, "app.ts"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "unsafe"); throw new Error("routes executed app.ts");\n`,
  );

  const result = spawnSync(
    process.execPath,
    ["--import", join(repo, "node_modules/tsx/dist/loader.mjs"), join(repo, "packages/cli/src/bin.ts"), "routes"],
    { cwd: project, encoding: "utf-8", timeout: 10_000 },
  );
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  assert("routes exits zero", result.status === 0, output);
  assert("canonical route is listed", output.includes(routePath), output);
  assert("app.ts is not executed", !existsSync(marker));
} finally {
  rmSync(project, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
