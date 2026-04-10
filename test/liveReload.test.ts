/**
 * Unit tests for the file watcher / live reload (packages/core/src/watcher.ts).
 * Run with: npx tsx test/liveReload.test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchForChanges, start, stop } from "../packages/core/src/watcher.ts";

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

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tina4-watcher-test-"));
}

const cleanups: (() => void)[] = [];

function runCleanups() {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
  cleanups.length = 0;
}

console.log("=== Watcher / Live Reload Tests ===\n");

// --- Existence & Shape ---
console.log("--- Exports and shape ---");

assert("watchForChanges is a function", typeof watchForChanges === "function");

{
  const dir = makeTempDir();
  const watcher = watchForChanges([dir], () => {});
  assert("returns object with close method", watcher !== undefined && typeof watcher.close === "function");
  watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir1 = makeTempDir();
  const dir2 = makeTempDir();
  const watcher = watchForChanges([dir1, dir2], () => {});
  assert("accepts array of directories", watcher !== undefined);
  watcher.close();
  rmSync(dir1, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

{
  const watcher = watchForChanges(["/tmp/does-not-exist-tina4-test"], () => {});
  assert("handles non-existent directories gracefully", watcher !== undefined);
  watcher.close();
}

// --- File Change Detection ---
console.log("\n--- File change detection ---");

{
  const dir = makeTempDir();
  let called = false;
  const watcher = watchForChanges([dir], () => { called = true; });

  writeFileSync(join(dir, "test.ts"), "export default 1;");
  await new Promise((r) => setTimeout(r, 400));
  assert("triggers callback on file create", called);

  watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir();
  const filePath = join(dir, "existing.ts");
  writeFileSync(filePath, "const a = 1;");
  await new Promise((r) => setTimeout(r, 100));

  let callCount = 0;
  const watcher = watchForChanges([dir], () => { callCount++; });

  writeFileSync(filePath, "const a = 2;");
  await new Promise((r) => setTimeout(r, 400));
  assert("triggers callback on file modify", callCount >= 1);

  watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir();
  let callCount = 0;
  const watcher = watchForChanges([dir], () => { callCount++; });

  writeFileSync(join(dir, "a.ts"), "1");
  writeFileSync(join(dir, "b.ts"), "2");
  writeFileSync(join(dir, "c.ts"), "3");

  await new Promise((r) => setTimeout(r, 400));
  assert("debounces rapid changes", callCount <= 2);

  watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir();
  const subDir = join(dir, "sub");
  mkdirSync(subDir, { recursive: true });

  let called = false;
  const watcher = watchForChanges([dir], () => { called = true; });

  writeFileSync(join(subDir, "nested.ts"), "nested");
  await new Promise((r) => setTimeout(r, 400));
  assert("watches subdirectories recursively", called);

  watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- Cleanup ---
console.log("\n--- Cleanup ---");

{
  const dir = makeTempDir();
  const watcher = watchForChanges([dir], () => {});
  let threw = false;
  try { watcher.close(); } catch { threw = true; }
  assert("close() stops without errors", !threw);
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir();
  const watcher = watchForChanges([dir], () => {});
  watcher.close();
  let threw = false;
  try { watcher.close(); } catch { threw = true; }
  assert("close() can be called multiple times", !threw);
  rmSync(dir, { recursive: true, force: true });
}

{
  const dir = makeTempDir();
  let called = false;
  const watcher = watchForChanges([dir], () => { called = true; });
  watcher.close();

  writeFileSync(join(dir, "after-close.ts"), "should not trigger");
  await new Promise((r) => setTimeout(r, 400));
  assert("does not trigger callback after close", !called);
  rmSync(dir, { recursive: true, force: true });
}

// --- start() / stop() API ---
console.log("\n--- start() / stop() API ---");

assert("start is a function", typeof start === "function");
assert("stop is a function", typeof stop === "function");

{
  // start() should not throw
  const dir = makeTempDir();
  let threw = false;
  try { start([dir], () => {}); } catch { threw = true; }
  assert("start() does not throw", !threw);
  stop();
  rmSync(dir, { recursive: true, force: true });
}

{
  // stop() without start should not throw
  let threw = false;
  try { stop(); } catch { threw = true; }
  assert("stop() without start does not throw", !threw);
}

{
  // start() is idempotent (calling twice does not duplicate watchers)
  const dir = makeTempDir();
  let callCount = 0;
  start([dir], () => { callCount++; });
  start([dir], () => { callCount += 100; }); // should be ignored

  writeFileSync(join(dir, "idempotent.ts"), "x");
  await new Promise((r) => setTimeout(r, 400));
  assert("start() is idempotent (second call ignored)", callCount >= 1 && callCount < 100);

  stop();
  rmSync(dir, { recursive: true, force: true });
}

{
  // start() detects file changes
  const dir = makeTempDir();
  let called = false;
  start([dir], () => { called = true; });

  writeFileSync(join(dir, "change.ts"), "hello");
  await new Promise((r) => setTimeout(r, 400));
  assert("start() triggers callback on file change", called);

  stop();
  rmSync(dir, { recursive: true, force: true });
}

{
  // stop() prevents further callbacks
  const dir = makeTempDir();
  let called = false;
  start([dir], () => { called = true; });
  stop();

  writeFileSync(join(dir, "after-stop.ts"), "nope");
  await new Promise((r) => setTimeout(r, 400));
  assert("stop() prevents further callbacks", !called);

  rmSync(dir, { recursive: true, force: true });
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
