/**
 * Regression: the test runner must still print its FINAL summary when stdout is
 * an asynchronous pipe -- a backgrounded run, `npm test | tee`, or a CI log
 * capture -- and not only in an interactive terminal.
 *
 * THE BUG. test/run-all.ts ended with `process.exit(1)`. A full run is ~260
 * back-to-back `execSync()` calls, and each one blocks the event loop for as
 * long as its child runs. When stdout is a pipe its writes are asynchronous and
 * buffered, so the per-file "PASS ..." lines queue up faster than libuv can
 * flush them and a large stdout backlog accumulates by the tail of the run.
 * `process.exit()` then tears the process down synchronously and DISCARDS that
 * backlog -- including the `Grand Total` summary written microseconds earlier.
 * The observable failure: a piped/backgrounded run stopped part-way down the
 * file list (roughly the last chunk that had flushed), printed no summary, and
 * exited 1 -- while the identical run in a TTY (where stdout is synchronous)
 * looked perfectly fine. That split -- fine in a terminal, truncated on a pipe
 * -- is the signature of this class of bug.
 *
 * THE FIX. Assign `process.exitCode` and let the process exit on its own. The
 * event loop drains the buffered writes first, so the summary always survives;
 * the runner holds no open handles (every child is reaped by execSync/spawnSync)
 * so it still exits promptly with the right code.
 *
 * HOW THIS PINS IT. Two REAL node processes over a REAL OS pipe -- no mocks. The
 * writer emits far more than one pipe buffer (~64KB) then a trailing sentinel;
 * the reader drains deliberately slowly, so the writer always has a large
 * unflushed backlog at teardown. Under `process.exitCode` the sentinel always
 * survives; under `process.exit()` it is lost. If someone reverts run-all.ts to
 * process.exit(), the positive case below starts failing.
 *
 * Measured on macOS (Node v24.9.0): exitCode 3/3 kept the sentinel, exit()
 * 0/3 kept it. The mechanism is POSIX-pipe + Node async stdout, identical on the
 * Linux lab / CI.
 *
 * Run with: npx tsx test/runnerExitFlush.test.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("=== runner exit flush (real pipe, real processes) ===\n");

const dir = mkdtempSync(join(tmpdir(), "tina4-exitflush-"));

// A runner-shaped writer: ~2.6MB of output (>> the ~64KB pipe buffer), then a
// single trailing sentinel that stands in for the Grand Total, then it ends by
// the mode named on argv -- "exit" => process.exit(1), else process.exitCode=1.
const SENTINEL = "SENTINEL_GRAND_TOTAL_LINE";
writeFileSync(
  join(dir, "writer.js"),
  `for (let i = 0; i < 20000; i++) console.log("f " + i + " " + "z".repeat(120));\n` +
    `console.log(${JSON.stringify(SENTINEL)});\n` +
    `if (process.argv[2] === "exit") process.exit(1);\n` +
    `else process.exitCode = 1;\n`,
);

// A deliberately slow REAL reader: it pauses synchronously on every chunk so it
// drains far slower than the writer produces, guaranteeing the writer holds a
// large unflushed backlog when it tears down. It re-emits everything it actually
// received, so the captured stdout is exactly what survived the writer's exit.
writeFileSync(
  join(dir, "slow-reader.js"),
  `let buf = Buffer.alloc(0);\n` +
    `process.stdin.on("data", (d) => {\n` +
    `  buf = Buffer.concat([buf, d]);\n` +
    `  const sab = new Int32Array(new SharedArrayBuffer(4));\n` +
    `  Atomics.wait(sab, 0, 0, 8);\n` +
    `});\n` +
    `process.stdin.on("end", () => process.stdout.write(buf));\n`,
);

// Run "writer <mode> | slow-reader" over a real pipe and capture what the reader
// saw. execFileSync(bash -c ...) keeps the pipeline a genuine OS pipe.
function survivedThroughPipe(mode: "exit" | "exitcode"): boolean {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `node ${JSON.stringify(join(dir, "writer.js"))} ${mode} | node ${JSON.stringify(join(dir, "slow-reader.js"))}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out.includes(SENTINEL);
}

try {
  // POSITIVE (the fix): process.exitCode drains stdout first, so the trailing
  // summary ALWAYS survives a slow pipe. Three runs, all must keep it.
  let keptWithExitCode = 0;
  for (let i = 0; i < 3; i++) if (survivedThroughPipe("exitcode")) keptWithExitCode++;
  assert(
    "process.exitCode: trailing summary survives a slow pipe every time",
    keptWithExitCode === 3,
    `${keptWithExitCode}/3 kept`,
  );

  // NEGATIVE (proves the gate is not vacuous): process.exit() drops the
  // unflushed backlog, so the trailing summary is lost. It truncates
  // essentially every time; require at least one truncation across three runs.
  let lostWithExit = 0;
  for (let i = 0; i < 3; i++) if (!survivedThroughPipe("exit")) lostWithExit++;
  assert(
    "process.exit(): trailing summary is truncated on a slow pipe",
    lostWithExit >= 1,
    `${lostWithExit}/3 truncated`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
