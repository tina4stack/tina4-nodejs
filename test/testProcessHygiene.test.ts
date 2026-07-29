/**
 * Test-suite process hygiene — a test must not leave a server running.
 *
 * The bug: devReloadWs.test.ts spawns `npx tsx app.ts`, which is a THREE-process
 * tree (npx -> tsx -> node app.ts). It called proc.kill("SIGKILL"), which
 * signals ONLY npx; the two children were reparented to init. Every run of the
 * Node suite therefore leaked a live dev server holding its port, and an orphan
 * that inherited the pipe makes `npm test | tee` never return -- the suite looks
 * hung long after it finished. The same killpg lesson the Rust CLI already
 * learned for its own npx -> tsx -> node respawn.
 *
 * The behavioural half of this is proved for real below: spawn the same shape of
 * tree, kill it the two different ways, and count what survives. Nothing is
 * simulated -- real processes, real signals, real survivor counts.
 *
 * The source-invariant half is deliberate. The leak is invisible in a green
 * suite (the tests pass; the orphan just stays), so a behavioural test alone
 * would not stop someone reintroducing `spawn(...)` without `detached` in a NEW
 * file. Reading the suite's own source is how that stays fixed. A previous
 * version of a check like this passed while three offenders remained, because
 * the pattern looked inside `spawn(` and the option is written a line later --
 * so this one scans the whole file.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** True while a pid is alive (signal 0 probes without delivering). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spawn a shell that spawns a long-lived grandchild -- the same shape as
 * `npx tsx app.ts`. Returns the shell's pid; the grandchild's pid arrives on
 * stdout so we can watch it independently.
 */
function spawnTree(detached: boolean): Promise<{ parent: number; child: number; kill: () => void }> {
  // sh -c "node -e '...' & echo $!; wait" gives a real two-level tree.
  const inner = 'setInterval(()=>{},1000); process.stdout.write("READY\\n")';
  const proc = spawn("sh", ["-c", `node -e '${inner}' & echo CHILD=$!; wait`], {
    detached,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    const bail = setTimeout(() => reject(new Error("tree never reported a child pid")), 5000);
    let buf = "";
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (d: string) => {
      buf += d;
      const m = /CHILD=(\d+)/.exec(buf);
      if (!m) return;
      clearTimeout(bail);
      resolve({
        parent: proc.pid!,
        child: parseInt(m[1]!, 10),
        kill: () => {
          try {
            if (detached) process.kill(-proc.pid!, "SIGKILL");
            else proc.kill("SIGKILL");
          } catch { /* already gone */ }
        },
      });
    });
    proc.once("error", reject);
  });
}

console.log("=== Test Process Hygiene ===\n");

// ── 1. The bug, reproduced: killing the parent leaves the grandchild ──

{
  const tree = await spawnTree(false);
  try {
    tree.kill();                       // proc.kill() -- parent only
    await sleep(400);
    assert(
      "killing only the parent LEAVES the grandchild alive (this is the bug)",
      alive(tree.child),
      "grandchild died too — the premise of the fix would not hold on this platform",
    );
  } finally {
    // We proved it survives, so we own killing it explicitly.
    try { process.kill(tree.child, "SIGKILL"); } catch { /* gone */ }
    try { process.kill(tree.parent, "SIGKILL"); } catch { /* gone */ }
  }
}

// ── 2. The fix: killing the GROUP takes the whole tree ──────────────

{
  const tree = await spawnTree(true);
  tree.kill();                         // process.kill(-pid) -- the group
  await sleep(400);
  assert(
    "killing the process GROUP reaps the parent",
    !alive(tree.parent),
    `pid ${tree.parent} still alive`,
  );
  assert(
    "killing the process GROUP reaps the grandchild too",
    !alive(tree.child),
    `pid ${tree.child} still alive`,
  );
}

// ── 3. Source invariant: no test may spawn a tree undetached ────────

{
  // Only a spawn that starts a LONG-LIVED tree needs the group treatment. A
  // `node -e <script>` child is a single process that exits on its own, so a
  // plain kill is correct there and this check must not flag it.
  const TREE_STARTERS = /spawn\(\s*["'](npx|npm|sh|bash|yarn|pnpm)["']/;

  // THIS file is the one legitimate exemption: case 1 above spawns an
  // undetached tree ON PURPOSE to prove the bug is real, and kills both pids
  // explicitly in its own finally. The exemption is this single file by name --
  // it is not a pattern any other test can opt into.
  const SELF = "testProcessHygiene.test.ts";

  const offenders: string[] = [];
  for (const file of readdirSync(HERE).filter((f) => f.endsWith(".ts"))) {
    if (file === SELF) continue;
    const src = readFileSync(path.join(HERE, file), "utf-8");
    if (!TREE_STARTERS.test(src)) continue;
    // Scan the WHOLE file, not the spawn( call: the option is written on a
    // later line, and matching inside the call silently found nothing before.
    if (!/detached:\s*true/.test(src)) offenders.push(file);
  }

  assert(
    "every test that spawns a process tree marks it detached (so the group can be killed)",
    offenders.length === 0,
    `undetached tree spawns in: ${offenders.join(", ")}`,
  );
}

// ── 4. Source invariant: a detached spawner must kill the group ─────

{
  const offenders: string[] = [];
  for (const file of readdirSync(HERE).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(path.join(HERE, file), "utf-8");
    if (!/detached:\s*true/.test(src)) continue;
    // A detached child outlives us unless something kills the group: look for
    // the negative-pid form. `proc.kill()` alone would NOT reap the tree.
    if (!/process\.kill\(\s*-/.test(src)) offenders.push(file);
  }

  assert(
    "every detached spawner kills the group (process.kill(-pid)), not just the parent",
    offenders.length === 0,
    `detached but no group kill in: ${offenders.join(", ")}`,
  );
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
