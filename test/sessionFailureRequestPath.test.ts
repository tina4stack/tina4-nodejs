/**
 * SESSION CONTRACT: a backend failure is LOUD, then degrades - on the REAL request path.
 * Run with: npx tsx test/sessionFailureRequestPath.test.ts
 *
 * ADR-0021 (session_contract.json #3): a backend that becomes unreachable
 * mid-request is LOGGED and then degraded - the read yields an empty session,
 * save() returns false, and the request STILL SERVES. It is never silent.
 * TINA4_SESSION_STRICT re-raises instead.
 *
 * WHY THIS FILE EXISTS, and why it is separate from sessionBackendFailure.test.ts.
 *
 * That file proves the policy on the Session OBJECT, against real unreachable
 * services. This file proves it on the HTTP REQUEST PATH, which is a different
 * code path and was NOT covered - and that is exactly where the policy was
 * missing. Measured at v3 HEAD, packages/core/src/dispatchPipeline.ts:
 *
 *     202:  const sess = new Session();
 *     203:  sess.start(existingSid);
 *
 * Guarded by nothing at all. A handler that cannot CONSTRUCT took the request
 * down with it - the database backend opens DatabaseSync and runs a PRAGMA in
 * its constructor, which sits outside Session's own safeRead/safeWrite policy -
 * and an unknown TINA4_SESSION_BACKEND, which the framework refuses LOUDLY by
 * design, 500'd every single request instead of degrading. And:
 *
 *     208:      sess.save();
 *     212:      try { sess.gc(); } catch { }
 *
 * The gc() two lines below WAS wrapped while the save() above it was not, so
 * the one call that can actually throw under strict mode was the unguarded one -
 * inside the monkey-patched res.end, where an uncaught throw is especially bad.
 *
 * THE OTHER HALF OF THE RULE, and the easy thing to get wrong when making
 * failures loud: a genuinely EMPTY session is NOT an error and must never be
 * logged as one. A first-time visitor with no cookie, and a cookie whose session
 * the store has never heard of, are both ORDINARY. If those log an error the log
 * fills with noise on every new visitor and the real outage becomes invisible -
 * the same blindness the fix was meant to cure. Case 3 is that control and it is
 * not optional.
 *
 * NO MOCKS. The unreachable backend is a genuinely closed TCP port, proven
 * closed by an out-of-band connect attempt before it is used. The logger is the
 * REAL logger writing real bytes to a real file which the test reads back, with
 * a driver-sanity check first so no "was logged" assertion can be vacuous and no
 * "logged nothing" assertion can be trivially true. Every request is a real HTTP
 * request over TCP against a real @tina4/core server started here and stopped at
 * the end.
 */
import { startServer, Log } from "../packages/core/src/index.ts";
import http from "node:http";
import { connect } from "node:net";
import {
  mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

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

/** A precondition that is not one of the four contract assertions, but still red. */
function guard(label: string, condition: boolean, detail = ""): boolean {
  if (!condition) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
    fail++;
  }
  return condition;
}

// A well-formed session id for a session no store has ever heard of. Sending a
// COOKIE is not decoration: without one the request path can take a "brand new
// session" branch, and an "unreachable backend" case would then pass while
// proving nothing. That exact trap produced a false green in the Python port.
const EXISTING_SESSION_COOKIE = { cookie: `tina4_session=${"a1b2c3d4".repeat(8)}` };

// ── Environment: saved up front, restored at the end ───────────────
const TOUCHED_ENV = [
  "TINA4_LOG_DIR", "TINA4_LOG_OUTPUT", "TINA4_LOG_FORMAT", "TINA4_LOG_LEVEL",
  "TINA4_SESSION_BACKEND", "TINA4_SESSION_STRICT", "TINA4_SESSION_PATH",
  "TINA4_SESSION_REDIS_HOST", "TINA4_SESSION_REDIS_PORT", "TINA4_DATABASE_URL",
  "TINA4_DEBUG", "TINA4_NO_BROWSER", "TINA4_RATE_LIMIT",
] as const;
const savedEnv = new Map<string, string | undefined>(
  TOUCHED_ENV.map((name) => [name, process.env[name]]),
);
function restoreEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// ── The REAL log sink: the real logger's real bytes, read back ─────
//
// Not a capture double. Log.error runs its whole real body - level gating,
// format selection, rotation check, the file write - and this reads the file
// afterwards, exactly as an operator would.
const logDir = mkdtempSync(join(tmpdir(), "tina4-session-loud-log-"));
const LOG_PATH = join(logDir, "tina4.log");
process.env.TINA4_LOG_DIR = logDir;
process.env.TINA4_LOG_OUTPUT = "file";   // file only: keeps the suite output clean
process.env.TINA4_LOG_FORMAT = "json";
process.env.TINA4_LOG_LEVEL = "DEBUG";
delete process.env.TINA4_DEBUG;          // production-shaped: no error overlay
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_RATE_LIMIT = "";       // rate limiter out of the way

let logMark = 0;

/** Remember the current end of the log, in BYTES (the file is utf-8, not ascii). */
function markLog(): void {
  logMark = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
}

/** Every ERROR message the real logger wrote since the last markLog(), in order. */
function errorsSinceMark(): string[] {
  if (!existsSync(LOG_PATH)) return [];
  const body = readFileSync(LOG_PATH).subarray(logMark).toString("utf-8");
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as { level?: string; message?: string };
      if (String(entry.level ?? "").toUpperCase() === "ERROR") {
        out.push(String(entry.message ?? ""));
      }
    } catch {
      /* a non-JSON line is not an entry this reader owns */
    }
  }
  return out;
}

const sessionErrors = (): string[] =>
  errorsSinceMark().filter((message) => /session/i.test(message));

// ── Genuinely closed TCP port, proven closed ───────────────────────

/** Bind an ephemeral port, learn its number, release it. Nothing listens after. */
const closedPort = freePort;

/** Out-of-band connect attempt. Asks the OS, not the code under test. */
function reachable(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

// ── A real app with one real route, served by a real server ────────
const APP_DIR = mkdtempSync(join(tmpdir(), "tina4-session-loud-app-"));
const SESSION_DIR = mkdtempSync(join(tmpdir(), "tina4-session-loud-store-"));
mkdirSync(join(APP_DIR, "src/routes/session-failure-probe"), { recursive: true });
writeFileSync(join(APP_DIR, "package.json"), '{"type":"module"}');
writeFileSync(
  join(APP_DIR, "src/routes/session-failure-probe/get.ts"),
  `
export default async function (req: any, res: any) {
  const session = req.session ?? null;
  return res.json({
    sessionPresent: session !== null,
    data: session !== null ? session.all() : null,
  });
}
`,
);

const PORT = await closedPort();

interface Answer { status: number; body: string }

function probe(headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1", port: PORT, method: "GET",
        path: "/session-failure-probe", headers,
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

console.log("=== Session failure on the REAL request path ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(APP_DIR, "src/routes"),
  modelsDir: join(APP_DIR, "src/models"),
  staticDir: join(APP_DIR, "public"),
});

// ── DRIVER SANITY ─────────────────────────────────────────────────
//
// Without this, every "was logged" assertion below is vacuous and every "logged
// nothing" assertion is trivially true - the negative control would prove the
// exact opposite of what it claims.
markLog();
Log.error("session-log-sink-selftest");
const sinkWorks = errorsSinceMark().some((m) => m.includes("session-log-sink-selftest"));
guard(
  "driver-sanity: the real logger's output is readable back",
  sinkWorks,
  `the real logger wrote nothing readable to ${LOG_PATH} - every log assertion `
  + "in this file would be meaningless",
);

if (sinkWorks) {
  // ── 1. An unusable backend leaves a record an operator can find ──
  //
  // TINA4_SESSION_BACKEND is set to a name the framework deliberately refuses.
  // That refusal is a loud Error by design, thrown from the Session constructor -
  // BEFORE there is an object for Session's own policy to apply to.
  {
    setEnv("TINA4_SESSION_BACKEND", "redsi");  // a real typo, deliberately refused
    markLog();

    await probe();

    const errors = sessionErrors();
    assert(
      "a_backend_failure_on_the_request_path_is_logged_not_silent",
      errors.some((message) => message.includes("redsi")),
      `an unusable session backend produced no error naming it on the real `
      + `request path - the operator has no signal at all. Errors seen: ${JSON.stringify(errors)}`,
    );
    setEnv("TINA4_SESSION_BACKEND", undefined);
  }

  // ── 2. Loud is only half the rule: the request must still be SERVED ──
  //
  // Degrading means the user gets their page without a session, not a 500. That
  // is what separates a degrade from an outage.
  //
  // TWO real failures, because Node has two distinct ones and only both together
  // cover the contract:
  //
  //   (a) a real backend pointed at a genuinely CLOSED TCP port - the literal
  //       "unreachable mid-request" of the invariant. It fails inside the READ,
  //       which is Session's own safeRead policy, so on its own this half is NOT
  //       a gate on the request path: it degrades even with the request-path
  //       guard removed. Kept because it is the invariant's own wording, and
  //       because it needs the COOKIE - without one the pipeline takes the
  //       "brand new session" branch and the backend read is never reached at
  //       all, which is how a case like this passes while proving nothing.
  //
  //   (b) a real backend that cannot be OPENED AT ALL. The database handler
  //       constructs DatabaseSync and runs a PRAGMA in its constructor, so it
  //       fails BEFORE there is a Session object for any of Session's policy to
  //       apply to. That is the half the request-path guard owns, and without it
  //       every single request 500s instead of degrading.
  {
    const deadPort = await closedPort();
    const answers = await reachable(deadPort);
    guard(
      "precondition: 127.0.0.1:" + deadPort + " really is closed",
      !answers,
      "something answered on the port this case needs to be dead, so it would "
      + "not be testing an unreachable backend at all",
    );

    setEnv("TINA4_SESSION_BACKEND", "redis");
    setEnv("TINA4_SESSION_REDIS_HOST", "127.0.0.1");
    setEnv("TINA4_SESSION_REDIS_PORT", String(deadPort));
    markLog();
    const unreachable = await probe(EXISTING_SESSION_COOKIE);
    const unreachableErrors = sessionErrors();
    setEnv("TINA4_SESSION_BACKEND", undefined);
    setEnv("TINA4_SESSION_REDIS_HOST", undefined);
    setEnv("TINA4_SESSION_REDIS_PORT", undefined);

    // A real SQLite store under a directory that does not exist. node:sqlite
    // genuinely cannot open it ("unable to open database file") and it throws
    // from the handler CONSTRUCTOR, before start() is ever called.
    setEnv("TINA4_SESSION_BACKEND", "database");
    setEnv("TINA4_DATABASE_URL", `sqlite:///${join(APP_DIR, "no-such-directory", "sessions.db")}`);
    markLog();
    const unopenable = await probe(EXISTING_SESSION_COOKIE);
    const unopenableErrors = sessionErrors();
    setEnv("TINA4_SESSION_BACKEND", undefined);
    setEnv("TINA4_DATABASE_URL", undefined);

    assert(
      "a_backend_failure_on_the_request_path_still_serves_the_request",
      unreachable.status === 200 && unreachableErrors.length > 0
      && unopenable.status === 200 && unopenableErrors.length > 0,
      `unreachable: status=${unreachable.status} (want 200) `
      + `errors=${JSON.stringify(unreachableErrors)}; `
      + `unopenable: status=${unopenable.status} (want 200) `
      + `errors=${JSON.stringify(unopenableErrors)} `
      + "- a broken backend must serve the request WITHOUT a session and log it. "
      + "A 500 is an outage, not a degrade; an unlogged 200 is the silence the "
      + "fix exists to end",
    );
  }

  // ── 3. NEGATIVE CONTROL - an EMPTY session is not a failure ──────
  //
  // The one most likely to be got wrong. A first-time visitor has no cookie and
  // therefore an empty session; a cookie for a session the store has never heard
  // of is equally ordinary. Neither is an error. If making failures loud also
  // makes these loud, the log fills with noise on every new visitor and the real
  // outage becomes invisible.
  //
  // Without this case, "log an error unconditionally" passes both cases above.
  {
    setEnv("TINA4_SESSION_BACKEND", "file");
    setEnv("TINA4_SESSION_PATH", SESSION_DIR);
    markLog();

    const fresh = await probe();                            // no cookie at all
    const unknown = await probe(EXISTING_SESSION_COOKIE);   // cookie, unknown id
    const errors = sessionErrors();

    assert(
      "an_empty_session_on_the_request_path_is_not_logged_as_a_failure",
      fresh.status === 200 && unknown.status === 200 && errors.length === 0,
      `fresh=${fresh.status} unknown=${unknown.status} `
      + `sessionErrors=${JSON.stringify(errors)} - a healthy backend with an `
      + "EMPTY session logged an error. An empty session is not a failure, and a "
      + "log that shouts on every new visitor buries the outage it exists to show",
    );

    setEnv("TINA4_SESSION_BACKEND", undefined);
    setEnv("TINA4_SESSION_PATH", undefined);
  }

  // ── 4. Strict mode REFUSES rather than serving a cheerful 200 ────
  //
  // Strict mode exists so an operator can choose "fail the request" over "serve
  // it without a session". Unguarded, the throw escaped dispatch entirely and
  // rejected the listener promise - which is a dead worker, not a refused
  // request. MEASURED outcome of the fixed pipeline: the framework's own error
  // path renders a 500, exactly as Python's re-raise becomes a 500 in the ASGI
  // server.
  {
    const deadPort = await closedPort();
    const answers = await reachable(deadPort);
    guard(
      "precondition: 127.0.0.1:" + deadPort + " really is closed",
      !answers,
      "something answered on the port this case needs to be dead",
    );

    setEnv("TINA4_SESSION_BACKEND", "redis");
    setEnv("TINA4_SESSION_REDIS_HOST", "127.0.0.1");
    setEnv("TINA4_SESSION_REDIS_PORT", String(deadPort));
    setEnv("TINA4_SESSION_STRICT", "true");
    markLog();

    const answer = await probe(EXISTING_SESSION_COOKIE);
    const errors = errorsSinceMark();
    const refusalIndex = errors.findIndex((message) => /^Route error:/.test(message));
    const sessionIndex = errors.findIndex((message) => /session/i.test(message));

    // The real driver failure must be visible. A strict mode that surfaces an
    // opaque wrapper tells the operator no more than silence did.
    const realCauseVisible = errors.some(
      (message) => /session/i.test(message) && /connect|refused|ECONNREFUSED/i.test(message),
    );
    // Logged BEFORE refusing: the session error is on record ahead of the
    // refusal, so the log has no hole exactly where the outage is.
    const loggedFirst = sessionIndex !== -1 && refusalIndex !== -1 && sessionIndex < refusalIndex;

    assert(
      "strict_mode_on_the_request_path_refuses_instead_of_degrading",
      answer.status === 500 && realCauseVisible && loggedFirst,
      `status=${answer.status} (want 500, not a cheerful 200) `
      + `realCauseVisible=${realCauseVisible} loggedBeforeRefusing=${loggedFirst} `
      + `errors=${JSON.stringify(errors)}`,
    );

    setEnv("TINA4_SESSION_STRICT", undefined);
    setEnv("TINA4_SESSION_BACKEND", undefined);
    setEnv("TINA4_SESSION_REDIS_HOST", undefined);
    setEnv("TINA4_SESSION_REDIS_PORT", undefined);
  }
}

// ── Reap what we spawned, restore what we changed ──────────────────
server.close();
restoreEnv();
for (const directory of [APP_DIR, SESSION_DIR, logDir]) {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
