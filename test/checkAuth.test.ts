/**
 * The route auth gate's three-source token resolution, driven for REAL.
 *
 * WHAT THIS FILE USED TO BE (and why it was worse than a mock): it declared a
 * 60-line in-test `function checkAuth(req: MockReq)` that RE-TYPED the auth
 * enforcement block, and then asserted that the COPY behaved. Every PASS was
 * compatible with the framework having no auth gate at all. The header claimed
 * the block lived in `server.ts`; by the time this conversion ran the real gate
 * had been extracted to `packages/core/src/authGate.ts` and `server.ts` no
 * longer contained the word `formToken` at all (measured: `grep -rn formToken
 * packages/core/src/server.ts` -> 0, against a control of `startServer` -> 12).
 * The copy had outlived the thing it copied and nothing noticed.
 *
 * WHAT IT IS NOW: one REAL server started by the REAL `startServer()` on a real
 * port, with REAL `http.request` calls over a real socket. The status codes,
 * the `FreshToken` header and the echoed `req.user` are all read off the wire.
 * The session-token source is driven by a REAL Session that a SEPARATE Session
 * instance persisted first -- so the value genuinely leaves this process, lands
 * in the store, and is read back by the server's own session bootstrap. That
 * cross-instance read-back is the only thing that proves a session value was
 * ever stored rather than kept in an in-process dict.
 *
 * Backends: the real FILE handler (always available -- real filesystem) and the
 * real REDIS handler (skips loudly naming host and port when redis is absent).
 *
 * Run with: npx tsx test/checkAuth.test.ts
 */
import http from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getToken, validToken, getPayload } from "../packages/core/src/auth.ts";
import { startServer } from "../packages/core/src/index.ts";
import { Session, sessionCookieName } from "../packages/core/src/session.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} ${detail}`);
  }
}

const SECRET = "test-secret-for-checkauth";
process.env.TINA4_SECRET = SECRET;
process.env.TINA4_RATE_LIMIT = "100000";
process.env.TINA4_NO_BROWSER = "true";

const REDIS_HOST = process.env.TINA4_SESSION_REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.TINA4_SESSION_REDIS_PORT ?? "6379");

/** Real TCP reachability probe -- no substitute for the service, just a gate. */
function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

console.log("=== Route auth gate (REAL server, REAL sockets) ===\n");

// ── A real project on disk with real route files ────────────────────────────
const root = mkdtempSync(join(tmpdir(), "tina4-checkauth-"));
const sessionDir = join(root, "sessions");
mkdirSync(sessionDir, { recursive: true });
mkdirSync(join(root, "src/routes/api/secure"), { recursive: true });
mkdirSync(join(root, "src/routes/api/open"), { recursive: true });
writeFileSync(join(root, "package.json"), '{"type":"module"}');

// A SECURE GET route. `export const secure = true` is the real opt-in that
// routeDiscovery threads into the router (routeDiscovery.ts:73). The handler
// echoes req.user, so the payload the REAL gate assigned is observable off the
// wire rather than being read out of a local variable.
const echoUser =
  "export const secure = true;\n" +
  "export default async function (req: any, res: any) {\n" +
  "  res.json({ ok: true, user: req.user ?? null });\n" +
  "}\n";
writeFileSync(join(root, "src/routes/api/secure/get.ts"), echoUser);

// A SECURE POST route (writes are secure-by-default) for the body formToken
// source. Same echo so the same assertions apply.
writeFileSync(
  join(root, "src/routes/api/secure/post.ts"),
  "export default async function (req: any, res: any) {\n" +
  "  res.json({ ok: true, user: req.user ?? null });\n" +
  "}\n"
);

// NEGATIVE CONTROL: a genuinely public route. Without this, a 'fix' that simply
// 401s everything would pass every rejection assertion in this file.
writeFileSync(
  join(root, "src/routes/api/open/get.ts"),
  "export default async function (_req: any, res: any) { res.json({ ok: true }); }\n"
);

interface Result {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: any = null;
          try { json = JSON.parse(text); } catch { /* not JSON -- assert on text */ }
          resolve({ status: res.statusCode!, headers: res.headers, body: text, json });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST a JSON body through the real pipeline (real Content-Type, real length). */
function postJson(port: number, path: string, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return request(port, "POST", path, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  }, body);
}

const PORT = 3711;
process.env.TINA4_SESSION_BACKEND = "file";
process.env.TINA4_SESSION_DIR = sessionDir;

const server = await startServer({
  port: PORT,
  routesDir: join(root, "src/routes"),
  modelsDir: join(root, "src/models"),
  staticDir: join(root, "public"),
});

try {
  // ── NEGATIVE CONTROL: the public route really is reachable ────────────────
  console.log("-- Negative control (a public route must still serve) --");
  {
    const r = await request(PORT, "GET", "/api/open");
    assert("public route serves 200 with no token at all", r.status === 200 && r.json?.ok === true,
      `status=${r.status} body=${r.body}`);
  }

  // ── Bearer header (priority 1) ────────────────────────────────────────────
  console.log("\n-- Bearer Header --");
  {
    const token = getToken({ userId: 1, role: "admin" }, 3600);
    const r = await request(PORT, "GET", "/api/secure", { Authorization: `Bearer ${token}` });
    assert("Valid Bearer header passes", r.status === 200, `status=${r.status} body=${r.body}`);
    assert("Bearer header sets user.userId", r.json?.user?.userId === 1);
    assert("Bearer header sets user.role", r.json?.user?.role === "admin");
    assert("Bearer header does not set FreshToken", r.headers["freshtoken"] === undefined,
      `got ${r.headers["freshtoken"]}`);
  }
  {
    const r = await request(PORT, "GET", "/api/secure", { Authorization: "Bearer invalid.token.here" });
    assert("Invalid Bearer header returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    const expired = getToken({ userId: 1 }, -1);
    const r = await request(PORT, "GET", "/api/secure", { Authorization: `Bearer ${expired}` });
    assert("Expired Bearer header returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    const r = await request(PORT, "GET", "/api/secure");
    assert("Missing Authorization header returns a real 401", r.status === 401, `status=${r.status}`);
  }

  // ── Body formToken (priority 2) + the FreshToken response header ──────────
  console.log("\n-- Body formToken --");
  {
    const token = getToken({ userId: 2, scope: "write" }, 3600);
    const r = await postJson(PORT, "/api/secure", { formToken: token, name: "Test" });
    assert("Valid body formToken passes", r.status === 200, `status=${r.status} body=${r.body}`);
    assert("Body formToken sets user.userId", r.json?.user?.userId === 2);
    assert("Body formToken sets user.scope", r.json?.user?.scope === "write");

    // The FreshToken is a REAL response header read off the socket -- not a
    // field on a captured object. This is the assertion the old copy could not
    // make, because it never emitted a header.
    const fresh = r.headers["freshtoken"];
    assert("FreshToken header is emitted on the real response", typeof fresh === "string" && fresh.length > 0,
      `got ${fresh}`);
    assert("FreshToken header is a valid JWT", typeof fresh === "string" && validToken(fresh) !== null);
    const freshPayload = typeof fresh === "string" ? getPayload(fresh) : null;
    assert("FreshToken preserves userId", freshPayload?.userId === 2);
    assert("FreshToken preserves scope", freshPayload?.scope === "write");
  }
  {
    const r = await postJson(PORT, "/api/secure", { formToken: "invalid.token.value" });
    assert("Invalid body formToken returns a real 401", r.status === 401, `status=${r.status}`);
  }
  {
    const expired = getToken({ userId: 1 }, -1);
    const r = await postJson(PORT, "/api/secure", { formToken: expired });
    assert("Expired body formToken returns a real 401", r.status === 401, `status=${r.status}`);
  }

  // ── Session token (priority 3), across TWO real backends ──────────────────
  //
  // The token is written by a SEPARATE Session instance and read back by the
  // server's own session bootstrap out of the real store. Nothing in this
  // process hands the server the value.
  async function sessionTokenMatrix(backendLabel: string) {
    console.log(`\n-- Session Token (REAL ${backendLabel} backend) --`);
    const cookieName = sessionCookieName();

    // Valid token, genuinely persisted, genuinely read back.
    {
      const token = getToken({ userId: 4, role: "viewer" }, 3600);
      const writer = new Session();
      const sid = writer.start();
      writer.set("token", token);
      writer.save();

      const r = await request(PORT, "GET", "/api/secure", { Cookie: `${cookieName}=${sid}` });
      assert(`[${backendLabel}] valid session token passes`, r.status === 200,
        `status=${r.status} body=${r.body}`);
      assert(`[${backendLabel}] session token sets user.userId`, r.json?.user?.userId === 4);
      assert(`[${backendLabel}] session token sets user.role`, r.json?.user?.role === "viewer");
      assert(`[${backendLabel}] session token does not set FreshToken`,
        r.headers["freshtoken"] === undefined, `got ${r.headers["freshtoken"]}`);
      writer.destroy();
    }

    // A garbage value genuinely stored in the real store.
    {
      const writer = new Session();
      const sid = writer.start();
      writer.set("token", "invalid.session.token");
      writer.save();
      const r = await request(PORT, "GET", "/api/secure", { Cookie: `${cookieName}=${sid}` });
      assert(`[${backendLabel}] invalid session token returns a real 401`, r.status === 401,
        `status=${r.status}`);
      writer.destroy();
    }

    // An expired JWT genuinely stored in the real store.
    {
      const expired = getToken({ userId: 1 }, -1);
      const writer = new Session();
      const sid = writer.start();
      writer.set("token", expired);
      writer.save();
      const r = await request(PORT, "GET", "/api/secure", { Cookie: `${cookieName}=${sid}` });
      assert(`[${backendLabel}] expired session token returns a real 401`, r.status === 401,
        `status=${r.status}`);
      writer.destroy();
    }

    // A cookie naming a session the store has never held.
    {
      const r = await request(PORT, "GET", "/api/secure", {
        Cookie: `${cookieName}=deadbeefdeadbeefdeadbeefdeadbeef`,
      });
      assert(`[${backendLabel}] unknown session id returns a real 401`, r.status === 401,
        `status=${r.status}`);
    }
  }

  process.env.TINA4_SESSION_BACKEND = "file";
  await sessionTokenMatrix("file");

  if (await reachable(REDIS_HOST, REDIS_PORT)) {
    process.env.TINA4_SESSION_BACKEND = "redis";
    process.env.TINA4_SESSION_REDIS_HOST = REDIS_HOST;
    process.env.TINA4_SESSION_REDIS_PORT = String(REDIS_PORT);
    await sessionTokenMatrix("redis");
    process.env.TINA4_SESSION_BACKEND = "file";
  } else {
    console.log(
      `  \x1b[33mSKIP\x1b[0m redis session-token matrix: redis not reachable at ${REDIS_HOST}:${REDIS_PORT}`
    );
  }

  // ── All sources invalid ───────────────────────────────────────────────────
  console.log("\n-- All Sources Invalid --");
  {
    const cookieName = sessionCookieName();
    const writer = new Session();
    const sid = writer.start();
    writer.set("token", "bad.session.jwt");
    writer.save();
    const r = await postJson(PORT, "/api/secure", { formToken: "bad.body.jwt" }, {
      Authorization: "Bearer bad.header.jwt",
      Cookie: `${cookieName}=${sid}`,
    });
    assert("All three sources invalid returns a real 401", r.status === 401, `status=${r.status}`);
    assert("All three sources invalid emits no FreshToken",
      r.headers["freshtoken"] === undefined, `got ${r.headers["freshtoken"]}`);
    writer.destroy();
  }
  {
    const r = await postJson(PORT, "/api/secure", {});
    assert("All sources missing/empty returns a real 401", r.status === 401, `status=${r.status}`);
  }

  // ── Priority chain: header > body > session ───────────────────────────────
  console.log("\n-- Priority Chain --");
  {
    const cookieName = sessionCookieName();
    const headerToken = getToken({ userId: 10, source: "header" }, 3600);
    const bodyToken = getToken({ userId: 20, source: "body" }, 3600);
    const sessionToken = getToken({ userId: 30, source: "session" }, 3600);

    const writer = new Session();
    const sid = writer.start();
    writer.set("token", sessionToken);
    writer.save();
    const cookie = `${cookieName}=${sid}`;

    // All three genuinely present on one real request -- header must win.
    const r1 = await postJson(PORT, "/api/secure", { formToken: bodyToken }, {
      Authorization: `Bearer ${headerToken}`,
      Cookie: cookie,
    });
    assert("Header wins when all three present", r1.json?.user?.source === "header",
      `got ${JSON.stringify(r1.json?.user)}`);
    assert("Header wins: correct userId", r1.json?.user?.userId === 10);
    assert("Header wins: no FreshToken", r1.headers["freshtoken"] === undefined);

    // Body + session, no header -- body wins AND emits FreshToken.
    const r2 = await postJson(PORT, "/api/secure", { formToken: bodyToken }, { Cookie: cookie });
    assert("Body wins when header absent", r2.json?.user?.source === "body",
      `got ${JSON.stringify(r2.json?.user)}`);
    assert("Body wins: correct userId", r2.json?.user?.userId === 20);
    assert("Body wins: FreshToken header is set", typeof r2.headers["freshtoken"] === "string");

    // Session only.
    const r3 = await request(PORT, "GET", "/api/secure", { Cookie: cookie });
    assert("Session wins when header and body absent", r3.json?.user?.source === "session",
      `got ${JSON.stringify(r3.json?.user)}`);
    assert("Session wins: correct userId", r3.json?.user?.userId === 30);
    assert("Session wins: no FreshToken", r3.headers["freshtoken"] === undefined);

    // Invalid header falls through to a valid body.
    const r4 = await postJson(PORT, "/api/secure", { formToken: bodyToken }, {
      Authorization: "Bearer invalid.header.jwt",
    });
    assert("Invalid header falls through to valid body", r4.json?.user?.source === "body",
      `got ${JSON.stringify(r4.json?.user)}`);
    assert("Fallthrough body: FreshToken header is set", typeof r4.headers["freshtoken"] === "string");

    // Invalid header + invalid body falls through to a valid session.
    const r5 = await postJson(PORT, "/api/secure", { formToken: "invalid.body.jwt" }, {
      Authorization: "Bearer invalid.header.jwt",
      Cookie: cookie,
    });
    assert("Invalid header+body falls through to valid session", r5.json?.user?.source === "session",
      `got ${JSON.stringify(r5.json?.user)}`);
    assert("Fallthrough session: no FreshToken", r5.headers["freshtoken"] === undefined);

    writer.destroy();
  }
} finally {
  server.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
