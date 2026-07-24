/**
 * Lock-in: port reclaiming never signals a PID it should not.
 *
 * Regression this pins down
 * -------------------------
 * Before starting, the CLI reclaims the port from a stale dev server by reading
 * `lsof -ti` and signalling what it finds. That output was never validated. Where
 * lsof prints a different shape than -ti implies, a non-numeric field becomes 0,
 * and signalling PID 0 sends the signal to EVERY process in the caller's own
 * process group.
 *
 * In a container the server IS PID 1, so it killed itself. This image logged
 *
 *     Killed existing process on port 7148 (PID: 1 /usr/local/bin/node ...)
 *
 * and then exited 143 -- a SIGTERM it sent to itself.
 *
 * Pure function of (lsof text, me, myGroup): no dependency, no double -- this is
 * not a mock test.
 *
 * Parity: Python selectable_pids, PHP tina4SelectablePids, Ruby selectable_pids.
 * Node core exposes no getpgrp(), so myGroup is optional here and unset by the
 * caller; the pid <= 1 guard already covers the dangerous coercion case.
 *
 * Run with: npx tsx test/selectablePids.test.ts
 */
import { selectablePids } from "../packages/cli/src/bin.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31m-\x1b[0m ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const eq = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ── negative cases: what must NEVER be signalled ────────────────────────────
{
  const junkWord = selectablePids("node", 999);
  assert("non-numeric token is never coerced into a PID", eq(junkWord, []), JSON.stringify(junkWord));

  // The exact shape from the real container log.
  const junkLine = selectablePids("1 /usr/local/bin/node app.ts", 999);
  assert("the real container log line yields no PID", eq(junkLine, []), JSON.stringify(junkLine));

  const zero = selectablePids("0", 999);
  assert("PID 0 is never signalled (it is our whole process group)", eq(zero, []), JSON.stringify(zero));

  const one = selectablePids("1", 999);
  assert("PID 1 is never signalled (init, or the server itself)", eq(one, []), JSON.stringify(one));

  const self = selectablePids("4242", 4242);
  assert("own PID is never signalled", eq(self, []), JSON.stringify(self));

  const group = selectablePids("777", 4242, 777);
  assert("own process group is never signalled", eq(group, []), JSON.stringify(group));

  assert("empty output yields nothing", eq(selectablePids("", 999), []));
  assert("whitespace-only output yields nothing", eq(selectablePids("   \n\t ", 999), []));
}

// ── positive cases: a real stale sibling still gets reclaimed ───────────────
{
  const one = selectablePids("5150", 4242);
  assert("a real foreign PID is selected", eq(one, [5150]), JSON.stringify(one));

  const many = selectablePids("5150\n5151\n5152", 4242);
  assert("every real foreign PID is selected", eq(many, [5150, 5151, 5152]), JSON.stringify(many));

  const mixed = selectablePids("node 0 1 4242 777 5150 5151", 4242, 777);
  assert(
    "unsafe PIDs are dropped while the safe ones survive",
    eq(mixed, [5150, 5151]),
    JSON.stringify(mixed),
  );

  const dupes = selectablePids("5150 5150 5150", 4242);
  assert("a duplicate PID is reported once", eq(dupes, [5150]), JSON.stringify(dupes));
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`,
);
process.exit(fail > 0 ? 1 : 0);
