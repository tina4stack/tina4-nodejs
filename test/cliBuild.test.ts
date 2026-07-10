/**
 * Real tests for the `build` CLI command (Phase 3, Node mirror).
 * Run with: npx tsx test/cliBuild.test.ts
 *
 * `build` produces the deployable Docker image (the artifact a Tina4 app ships),
 * not a library package. No mocks:
 *
 *   • the fail-loud guards are asserted with a REAL filesystem and a REAL,
 *     genuinely-empty PATH (so whichDocker() really returns null). process.exit
 *     is intercepted to a throw — the Node equivalent of pytest.raises(SystemExit)
 *     — so the guard's real exit code + output are observed without killing the
 *     runner; every filesystem/PATH fact stays real;
 *   • when a real Docker daemon is available, a real `docker build` of a
 *     network-free `FROM scratch` image is run and the resulting image is
 *     inspected in the daemon, then cleaned up. Skipped LOUDLY (with the reason)
 *     only when docker is genuinely absent.
 *
 * Mirrors tina4-python/tests/test_cli_build.py.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildImage } from "../packages/cli/src/commands/build.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  PASS ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    fail++;
  }
}

interface RunResult { code: number | null; out: string }

/**
 * Run buildImage in-process with a real cwd (and optional real PATH override),
 * intercepting process.exit into a throw so its exit code is observed — the Node
 * analogue of pytest.raises(SystemExit). Every filesystem/PATH fact is real.
 */
function runBuild(args: string[], cwd: string, pathOverride?: string): RunResult {
  const prevCwd = process.cwd();
  const prevExit = process.exit;
  const prevLog = console.log;
  const prevPath = process.env.PATH;
  let out = "";
  let code: number | null = null;

  console.log = (...a: unknown[]) => { out += a.map(String).join(" ") + "\n"; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (c?: number) => { throw { __exit: true, code: c ?? 0 }; };

  try {
    if (pathOverride !== undefined) process.env.PATH = pathOverride;
    process.chdir(cwd);
    buildImage(args);
  } catch (e: unknown) {
    const ex = e as { __exit?: boolean; code?: number };
    if (ex && ex.__exit) { code = ex.code ?? 0; }
    else { console.log = prevLog; process.exit = prevExit; process.env.PATH = prevPath; process.chdir(prevCwd); throw e; }
  } finally {
    process.chdir(prevCwd);
    process.exit = prevExit;
    console.log = prevLog;
    process.env.PATH = prevPath;
  }
  return { code, out };
}

function dockerReady(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
  return r.status === 0;
}

const baseTmp = mkdtempSync(join(tmpdir(), "tina4-clibuild-"));

console.log("=== CLI `build` Command Tests (real FS, real docker) ===\n");

// ── Fail-loud guards ───────────────────────────────────────────────────
console.log("--- fail-loud guards ---");
{
  // No Dockerfile at all.
  const dir = join(baseTmp, "no_dockerfile");
  mkdirSync(dir, { recursive: true });
  const { code, out } = runBuild([], dir);
  assert("no Dockerfile exits 1", code === 1, `exit ${code}`);
  assert("no Dockerfile says 'No Dockerfile'", out.includes("No Dockerfile"), out);
  assert("no Dockerfile gives actionable guidance (deploy docker)",
    out.includes("tina4 deploy docker"), out);
}
{
  // Dockerfile present, but docker genuinely absent (real empty PATH).
  const dir = join(baseTmp, "docker_absent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n", "utf-8");
  const emptyBin = join(dir, "emptybin");
  mkdirSync(emptyBin, { recursive: true });
  const { code, out } = runBuild([], dir, emptyBin);
  assert("Dockerfile present + docker absent exits 1", code === 1, `exit ${code}`);
  assert("docker-absent guard mentions docker", out.toLowerCase().includes("docker"), out);
}
{
  // Explicit --file that does not exist.
  const dir = join(baseTmp, "custom_file_missing");
  mkdirSync(dir, { recursive: true });
  const { code, out } = runBuild(["--file", "docker/prod/Dockerfile"], dir);
  assert("missing --file exits 1", code === 1, `exit ${code}`);
  assert("missing --file names the path", out.includes("docker/prod/Dockerfile"), out);
}

// ── Real docker build (only when a daemon is genuinely available) ──────
console.log("\n--- real docker build ---");
if (!dockerReady()) {
  console.log("  SKIP real docker build — no docker daemon reachable on PATH (`docker info` failed).");
} else {
  const dir = join(baseTmp, "real_build");
  mkdirSync(dir, { recursive: true });
  // FROM scratch needs no registry pull → a real, offline docker build.
  writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n", "utf-8");
  const tag = "tina4-node-build-test:latest";
  try {
    const { code, out } = runBuild(["--tag", tag], dir);
    assert("real build did not fail-exit", code === null, `exit ${code}`);
    assert("real build reports the built image", out.includes(`Built image ${tag}`), out);
    assert("real build prints a run hint (port 7148)", out.includes("docker run -p 7148:7148"), out);
    // The real artifact exists in the docker daemon.
    const inspect = spawnSync("docker", ["image", "inspect", tag], { stdio: "ignore" });
    assert("built image exists in the docker daemon", inspect.status === 0, `inspect exit ${inspect.status}`);
  } finally {
    spawnSync("docker", ["image", "rm", "-f", tag], { stdio: "ignore" });
  }
}

// ── Summary ─────────────────────────────────────────────────────────
try { rmSync(baseTmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
