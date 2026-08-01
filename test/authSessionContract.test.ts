/**
 * Regression tests for the feature 41/42 auth + session contract (ADR-0021).
 *
 * Each test is named for the behaviour it pins and carries a positive AND a
 * negative case, so reverting a fix reproduces the original bug rather than
 * silently passing. The case names are IDENTICAL in all four frameworks
 * (tina4-python/tests/test_auth_session_contract.py,
 * tina4-php/tests/AuthSessionContractTest.php,
 * tina4-ruby/spec/auth_session_contract_spec.rb).
 *
 * No doubles anywhere: real Auth against real node:crypto HMAC digests, real
 * Session against a real filesystem in a real mkdtemp directory.
 *
 * Run with: npx tsx test/authSessionContract.test.ts
 */
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { authenticateRequest, getToken, validToken } from "../packages/core/src/auth.ts";
import { FileSessionHandler, Session, isValidSessionId } from "../packages/core/src/session.ts";

// ── Harness ───────────────────────────────────────────────────────
//
// One PASS/FAIL line per NAMED test (the names above), so a surgical break in
// the framework turns exactly ONE line red rather than the whole file. The
// individual checks inside a test print underneath it when it fails, so the
// specific half that broke is still visible.

let passed = 0;
let failed = 0;

type Check = (condition: boolean, detail: string) => void;

function test(name: string, body: (check: Check) => void): void {
  const problems: string[] = [];
  const check: Check = (condition, detail) => {
    if (!condition) problems.push(detail);
  };
  try {
    body(check);
  } catch (error) {
    problems.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (problems.length === 0) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    for (const problem of problems) console.log(`         ${problem}`);
  }
}

/** Run `body` with a fresh temp directory that is always removed afterwards. */
function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tina4-auth-session-contract-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test fixtures ─────────────────────────────────────────────────

const SECRET = "auth-session-contract-secret";
process.env.TINA4_SECRET = SECRET;
delete process.env.TINA4_JWT_ALGORITHM;
delete process.env.TINA4_SESSION_BACKEND;
delete process.env.TINA4_SESSION_STRICT;

const base64url = (raw: Buffer | string): string =>
  Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * Mint a token with arbitrary claims, correctly signed with a REAL HMAC.
 *
 * The signature is genuine, so every test below isolates the CLAIM check under
 * test rather than accidentally passing because the signature failed.
 */
function forge(claims: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = base64url(createHmac("sha256", SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Claim values that are PRESENT but are not an RFC 7519 NumericDate. */
const NON_NUMERIC_CLAIMS: unknown[] = ["not-a-number", null, [], {}, true];
const describeClaim = (value: unknown): string => JSON.stringify(value) ?? "undefined";

// ── 0: the child process must be running THIS worktree's framework ──

test("framework source resolves inside this worktree", (check) => {
  // A spawned test child can silently resolve an INSTALLED tina4-nodejs
  // instead of the source under edit, which would make every result below a
  // statement about the wrong code. Resolve the module specifier this file
  // actually imports and prove it points into the working tree.
  const authPath = fileURLToPath(import.meta.resolve("../packages/core/src/auth.ts"));
  const sessionPath = fileURLToPath(import.meta.resolve("../packages/core/src/session.ts"));
  console.log(`         auth    -> ${authPath}`);
  console.log(`         session -> ${sessionPath}`);
  check(!authPath.includes("node_modules"), `auth resolved through node_modules: ${authPath}`);
  check(!sessionPath.includes("node_modules"), `session resolved through node_modules: ${sessionPath}`);
  check(existsSync(authPath), `resolved auth source does not exist: ${authPath}`);
  check(existsSync(sessionPath), `resolved session source does not exist: ${sessionPath}`);
});

// ── 42: a session id is opaque and can never be a filesystem path ──

test("session id from cookie cannot escape the session directory", (check) => {
  // The exact exploit: FileSessionHandler.filePath() joins the RAW cookie value
  // onto the storage path, and start() ADOPTS an id whose read succeeded. So a
  // traversal cookie pointed at an EXISTING .json outside the session directory
  // both leaked that file into session.all() and overwrote it on save().
  withTempDir((dir) => {
    const sessions = join(dir, "data", "sessions");
    mkdirSync(sessions, { recursive: true });
    const outside = join(dir, "OUTSIDE");
    mkdirSync(outside, { recursive: true });

    const target = join(outside, "appconfig.json");
    const originalBytes = JSON.stringify({ apiKey: "SUPER-SECRET-KEY", dbPassword: "hunter2" });
    writeFileSync(target, originalBytes, "utf-8");

    const session = new Session("file", { path: sessions, ttl: 3600 });
    const adopted = session.start("../../OUTSIDE/appconfig");
    session.set("owned", "yes");
    session.save();

    // Negative half: no disclosure, no overwrite, no adoption.
    const leaked = session.all();
    check(
      !("apiKey" in leaked) && !("dbPassword" in leaked),
      `session cookie read a file outside the session directory: ${JSON.stringify(leaked)}`,
    );
    check(
      readFileSync(target, "utf-8") === originalBytes,
      "session cookie escaped the session directory - arbitrary file write",
    );
    check(adopted !== "../../OUTSIDE/appconfig", "a traversal session id was adopted verbatim");
    check(isValidSessionId(adopted), `replacement id is itself invalid: ${adopted}`);
    check(
      JSON.stringify(readdirSync(outside)) === JSON.stringify(["appconfig.json"]),
      `a file was created outside the session directory: ${JSON.stringify(readdirSync(outside))}`,
    );

    // Positive half: a legitimate session in the same directory still works.
    const good = new Session("file", { path: sessions, ttl: 3600 });
    const goodId = good.start();
    good.set("k", "v");
    good.save();
    const resumed = new Session("file", { path: sessions, ttl: 3600 });
    resumed.start(goodId);
    check(resumed.get("k") === "v", "a legitimate session no longer round-trips");
  });
});

test("session id with path separator is rejected and a fresh id minted", (check) => {
  withTempDir((dir) => {
    // PLANT the file each hostile id's raw `join(path, id + ".json")` would
    // land on. Without this the ids are refused for the wrong reason - the
    // read simply misses - and the test passes even WITH the bug present.
    mkdirSync(join(dir, "a"), { recursive: true });
    const planted: Record<string, string> = {
      "a/b": join(dir, "a", "b.json"),
      "a\\b": join(dir, "a\\b.json"),
      "a.b": join(dir, "a.b.json"),
      "..": join(dir, "...json"),
    };
    for (const [id, target] of Object.entries(planted)) {
      writeFileSync(target, JSON.stringify({ marker: `planted-${id}` }), "utf-8");
    }

    // Every entry is outside the opaque ALPHABET. Length is deliberately NOT a
    // criterion: a short id like "short" is well-formed (an app calling
    // start("my-session-id") is a trusted caller managing its own id) and is
    // covered by the strict-mode test instead.
    for (const hostile of ["../../etc/passwd", "a/b", "a\\b", "a.b", "..", ""]) {
      const session = new Session("file", { path: dir, ttl: 3600 });
      const adopted = session.start(hostile);
      check(adopted !== hostile, `hostile session id adopted verbatim: ${JSON.stringify(hostile)}`);
      check(
        isValidSessionId(adopted),
        `replacement id is itself invalid for input ${JSON.stringify(hostile)}: ${adopted}`,
      );
      check(
        !("marker" in session.all()),
        `hostile id ${JSON.stringify(hostile)} read a planted file: ${JSON.stringify(session.all())}`,
      );
      const target = planted[hostile];
      if (target) {
        check(
          readFileSync(target, "utf-8") === JSON.stringify({ marker: `planted-${hostile}` }),
          `hostile id ${JSON.stringify(hostile)} overwrote a planted file`,
        );
      }
    }

    // Positive half: the rejection is SELECTIVE, not a blanket "never resume".
    const seed = new Session("file", { path: dir, ttl: 3600 });
    const seedId = seed.start();
    seed.set("kept", true);
    seed.save();
    const resumed = new Session("file", { path: dir, ttl: 3600 });
    check(resumed.start(seedId) === seedId, "a well-formed id was not resumed as-is");
    check(resumed.get("kept") === true, "a well-formed id did not carry its data");
  });
});

test("a legitimate session still round trips", (check) => {
  // NEGATIVE CONTROL for every other session test in this file. Without it, a
  // "fix" that simply broke all sessions - refuse every id, never persist -
  // would pass all the traversal assertions and look green.
  withTempDir((dir) => {
    const session = new Session("file", { path: dir, ttl: 3600 });
    const id = session.start();
    session.set("user_id", 42);
    session.set("nested", { role: "admin" });
    check(session.save(), "save() reported a failed write on a healthy file backend");

    const resumed = new Session("file", { path: dir, ttl: 3600 });
    check(resumed.start(id) === id, "a known id was not resumed under the same id");
    check(resumed.get("user_id") === 42, `a saved scalar did not survive the round trip: ${resumed.get("user_id")}`);
    check(
      JSON.stringify(resumed.get("nested")) === JSON.stringify({ role: "admin" }),
      "a saved object did not survive the round trip",
    );

    // ...and the session is genuinely on disk under this handler, not in memory.
    check(
      readdirSync(dir).filter((f) => f.endsWith(".json")).length > 0,
      "no session file was written to the storage directory",
    );
  });
});

test("well formed unknown session id is not adopted", (check) => {
  // STRICT SESSION MODE (OWASP; PHP's session.use_strict_mode=1 default). Node
  // is the family reference here: an id that passes the alphabet check but that
  // the store has never issued is DISCARDED, not adopted, so an attacker cannot
  // plant a session id that survives the victim's login (session fixation).
  withTempDir((dir) => {
    const unknown = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // well-formed, never issued
    check(isValidSessionId(unknown), "the fixture id is not well-formed - test is not testing what it claims");

    const session = new Session("file", { path: dir, ttl: 3600 });
    const adopted = session.start(unknown);
    check(adopted !== unknown, "a well-formed but UNKNOWN session id was adopted (session fixation)");
    check(isValidSessionId(adopted), `replacement id is itself invalid: ${adopted}`);

    // Positive half: a KNOWN id resumes unchanged, so the rejection above is
    // about the id being unknown, not about rejecting everything.
    const known = new Session("file", { path: dir, ttl: 3600 });
    const knownId = known.start();
    known.set("k", "v");
    known.save();
    const resumed = new Session("file", { path: dir, ttl: 3600 });
    check(resumed.start(knownId) === knownId, "a KNOWN id was not resumed unchanged");
    check(resumed.get("k") === "v", "a KNOWN id did not carry its data");
  });
});

test("valid generated session id is accepted unchanged", (check) => {
  withTempDir((dir) => {
    const session = new Session("file", { path: dir, ttl: 3600 });
    const minted = session.start();
    check(isValidSessionId(minted), `the framework's own minted id is rejected: ${minted}`);

    const resumed = new Session("file", { path: dir, ttl: 3600 });
    check(resumed.start(minted) === minted, "a self-minted id was not resumed as-is");

    // The id shapes the other three frameworks mint must also be accepted, so a
    // shared Redis/Mongo session store stays readable across the family.
    for (const foreign of [
      "0123456789abcdef0123456789abcdef", // PHP/Node hex(16)
      "0".repeat(64),                     // Ruby hex(32)
      "Ab-_9".repeat(8),                  // Python token_urlsafe
    ]) {
      check(isValidSessionId(foreign), `rejected a sibling id shape: ${foreign}`);
    }

    // Negative half: the validator is not a rubber stamp. The rejected set is
    // exactly "outside the alphabet" plus the 128-char ceiling — a SHORT id is
    // deliberately NOT rejected (see the strict-mode test), because an entropy
    // floor closes no attack and would break trusted callers passing their own
    // id, while `.` and `/` are the characters that actually steered a path.
    for (const bad of ["../../etc/passwd", "a/b", "a.b", "..", "", "x".repeat(129)]) {
      check(!isValidSessionId(bad), `accepted a non-opaque id: ${JSON.stringify(bad)}`);
    }
    for (const shortButLegal of ["short", "my-session-id", "a", "test_session"]) {
      check(
        isValidSessionId(shortButLegal),
        `rejected a short but well-formed id a trusted caller may pass: ${shortButLegal}`,
      );
    }
    for (const notAString of [null, undefined, 12345678901234567890, [], {}]) {
      check(!isValidSessionId(notAString), `accepted a non-string id: ${String(notAString)}`);
    }

    // Defence in depth: the handler itself refuses a non-conforming id, so a
    // direct handler call can never derive a path from a hostile string either.
    const handler = new FileSessionHandler(dir);
    let refused = false;
    try {
      handler.read("../../OUTSIDE/appconfig");
    } catch {
      refused = true;
    }
    check(refused, "FileSessionHandler.read accepted a traversal id");
    refused = false;
    try {
      handler.write("../../OUTSIDE/appconfig", { _created: 1, _accessed: 1 }, 0);
    } catch {
      refused = true;
    }
    check(refused, "FileSessionHandler.write accepted a traversal id");
    // ...and still serves a well-formed id unchanged (non-breaking).
    handler.write(minted, { _created: 1, _accessed: 1, ok: true }, 0);
    check(
      (handler.read(minted) as Record<string, unknown> | null)?.ok === true,
      "the handler no longer round-trips a well-formed id",
    );
  });
});

// ── 41: RFC 7519 s4.1.4 - the token MUST NOT be accepted at or after exp ──

test("jwt expired exactly at exp is rejected", (check) => {
  // RFC 7519 s4.1.4: "the current date/time MUST be before the expiration
  // date/time". At now == exp the token is expired. Ruby already used >=;
  // Python, PHP and Node used > and accepted a token for one extra tick.
  const now = nowSeconds();
  check(
    validToken(forge({ user_id: 1, exp: now })) === null,
    "token accepted at exactly exp - RFC 7519 s4.1.4 requires now < exp",
  );

  // The same boundary on a FRACTIONAL NumericDate (RFC 7519 s2 permits one).
  // This is where Node's float clock differed measurably rather than by a
  // sub-millisecond: `Date.now()/1000 > exp` was FALSE for an exp half a second
  // into the current second, so the token was accepted. Truncating both sides
  // to integer seconds is what makes the boundary byte-identical to PHP/Ruby.
  check(
    validToken(forge({ user_id: 1, exp: now + 0.5 })) === null,
    "token accepted at a fractional exp inside the current second",
  );

  // Positive half: the rejection is the BOUNDARY, not a blanket reject.
  check(validToken(forge({ user_id: 1, exp: now + 600 })) !== null, "a valid unexpired token was rejected");
});

test("jwt one second before exp is accepted", (check) => {
  const now = nowSeconds();
  const payload = validToken(forge({ user_id: 1, exp: now + 2 }));
  check(payload !== null, "a token two seconds from expiry was rejected");
  check(payload?.user_id === 1, "the accepted token did not carry its claims");

  // Negative half: one second PAST exp is still rejected.
  check(validToken(forge({ user_id: 1, exp: now - 1 })) === null, "a token one second past exp was accepted");
});

test("jwt non numeric exp is rejected not treated as no expiry", (check) => {
  // RFC 7519 s2 defines exp as a NumericDate. Node skipped the whole expiry
  // check when exp was not a number (`typeof payload.exp === "number"`),
  // turning a malformed claim into a token that never expires.
  for (const badExp of NON_NUMERIC_CLAIMS) {
    check(
      validToken(forge({ user_id: 1, exp: badExp })) === null,
      `token with exp=${describeClaim(badExp)} was accepted as non-expiring`,
    );
  }

  // Positive half: a well-formed exp in the future is still accepted, and NO
  // exp key at all stays unconstrained (non-breaking).
  check(validToken(forge({ user_id: 1, exp: nowSeconds() + 600 })) !== null, "a valid exp was rejected");
  check(validToken(forge({ user_id: 1 })) !== null, "a token with no exp key was rejected");
});

test("jwt non numeric nbf is rejected not treated as unconstrained", (check) => {
  const now = nowSeconds();
  for (const badNbf of NON_NUMERIC_CLAIMS) {
    check(
      validToken(forge({ user_id: 1, exp: now + 600, nbf: badNbf })) === null,
      `token with nbf=${describeClaim(badNbf)} was accepted as unconstrained`,
    );
  }

  // Positive half: NO nbf at all stays unconstrained, and a past nbf passes.
  check(validToken(forge({ user_id: 1, exp: now + 600 })) !== null, "a token with no nbf key was rejected");
  check(
    validToken(forge({ user_id: 1, exp: now + 600, nbf: now - 60 })) !== null,
    "a token whose nbf has already passed was rejected",
  );
  // Negative half: a genuinely post-dated token is still refused.
  check(
    validToken(forge({ user_id: 1, exp: now + 6000, nbf: now + 3600 })) === null,
    "a post-dated token was accepted",
  );
});

// ── 41: authenticateRequest authenticates, or returns null ──

test("basic authorization header is not an authenticated request", (check) => {
  // Basic credentials are not verified against anything, so they are not auth.
  // Python returned a TRUTHY dict for any Basic header, so an app following the
  // documented `if (!auth) return 401` idiom authenticated every caller.
  const credentials = Buffer.from("admin:whatever-i-like").toString("base64");
  check(
    authenticateRequest({ authorization: `Basic ${credentials}` }) === null,
    "an unverified Basic header authenticated the request",
  );

  // Positive half: a real Bearer JWT still authenticates.
  const token = getToken({ user_id: 7 }, SECRET);
  const payload = authenticateRequest({ authorization: `Bearer ${token}` });
  check(payload !== null && payload.user_id === 7, "a valid Bearer JWT no longer authenticates");
});

test("authenticate request api key payload shape is uniform", (check) => {
  // "_auth" is the cross-framework key for a non-JWT auth result.
  const previous = process.env.TINA4_API_KEY;
  process.env.TINA4_API_KEY = "contract-api-key-value";
  try {
    const payload = authenticateRequest({ authorization: "Bearer contract-api-key-value" });
    check(
      JSON.stringify(payload) === JSON.stringify({ _auth: "api_key" }),
      `api_key payload shape drifted: ${JSON.stringify(payload)}`,
    );
    // Negative half: a wrong key is not authenticated.
    check(authenticateRequest({ authorization: "Bearer wrong-key" }) === null, "a wrong API key authenticated");
  } finally {
    if (previous === undefined) delete process.env.TINA4_API_KEY;
    else process.env.TINA4_API_KEY = previous;
  }
});

test("backend outage does not rotate the session id", (check) => {
  // An unreachable backend must DEGRADE, never rotate. Strict mode discards an
  // id the store does not KNOW; a store that does not ANSWER is not evidence of
  // that, and treating it as such rotates the id on every request for the whole
  // outage - logging every user out over a blip and orphaning their sessions.
  // A REAL handler whose backend is down: it throws, exactly as the shipped
  // Redis/Valkey/Mongo handlers do on an unreachable server. No doubles.
  const downBackend = {
    read(): never { throw new Error("redis unreachable"); },
    write(): never { throw new Error("redis unreachable"); },
    destroy(): never { throw new Error("redis unreachable"); },
  };

  const supplied = "abcdef0123456789abcdef0123456789";
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = new Session("file");
    s.setHandler(downBackend as never);
    seen.push(s.start(supplied));
  }
  check(
    seen.every((id) => id === supplied),
    `session id rotated during a backend outage: ${JSON.stringify(seen)}`,
  );

  // Negative half: a HEALTHY store that genuinely has no such session must
  // still discard the id, or strict mode has been disabled rather than fixed.
  const dir = mkdtempSync(join(tmpdir(), "tina4-outage-"));
  try {
    const healthy = new Session("file", { path: dir });
    check(
      healthy.start(supplied) !== supplied,
      "strict mode stopped discarding an unknown id on a healthy backend",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
