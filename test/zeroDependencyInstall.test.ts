/**
 * ZERO-DEPENDENCY INSTALL: `npm install tina4-nodejs` adds exactly ONE package.
 * Run with: npx tsx test/zeroDependencyInstall.test.ts
 *
 * ADR-0067: database drivers and optional servers are APPLICATION dependencies,
 * never framework runtime dependencies. Through 3.13.137 the five driver
 * packages (pg, mongodb, redis, @aws-sdk/client-s3, @aws-sdk/s3-request-presigner)
 * sat in `optionalDependencies`, which npm INSTALLS BY DEFAULT: a plain
 * `npm install tina4-nodejs` pulled in 64 packages for an app that only ever
 * used SQLite. They are optional PEER dependencies now, which npm does not
 * install, so the app decides.
 *
 * The flip side is that "missing" becomes the NORMAL state, so every place the
 * framework reaches for one of those packages must say exactly what to run.
 *
 * NO MOCKS. This is a real consumer: the real `npm pack` tarball, a plain
 * `npm install` into an empty project OUTSIDE the monorepo (so nothing can
 * resolve from the repository's own node_modules), and a consumer script run
 * with plain `node` against the published `dist` - exactly what an app gets.
 * The missing packages are genuinely absent; nothing is shimmed. The consumer
 * SELF-VERIFIES that instrument first: it counts how many of the five it can
 * resolve, and every negative assertion below is meaningless unless that is 0.
 *
 * POSITIVE: the same project then runs `npm install pg mongodb redis` and uses
 * each against a REAL server - PostgreSQL through the ORM and the database
 * session handler, the MongoDB queue (whose child process must find the
 * app-installed driver), and a Redis backplane publish/subscribe - proving
 * every peer is found once the app installs it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = join(import.meta.dirname, "..");

const OPTIONAL_PEERS = [
  "pg", "mongodb", "redis", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner",
  "mysql2", "tedious", "node-firebird", "odbc",
];
// The published manifest must DECLARE the SQL drivers too, as optional peers,
// with the range the adapters are tested against (packages/orm's manifest), so
// npm can warn an app that installs an incompatible major. Undeclared, npm
// never checks the version at all.
const DECLARED_SQL_DRIVER_PEERS: Record<string, string> = {
  mysql2: "^3.22.5",
  tedious: "^19.2.1",
  "node-firebird": "^2.14.3",
  odbc: "^2.4.9",
};

const PG_HOST = process.env.TINA4_TEST_PG_HOST ?? "localhost";
const PG_PORT = parseInt(process.env.TINA4_TEST_PG_PORT ?? "5432", 10);
const PG_USER = process.env.TINA4_TEST_PG_USERNAME ?? "tina4";
const PG_PASS = process.env.TINA4_TEST_PG_PASSWORD ?? "tina4";
const PG_DB = process.env.TINA4_TEST_PG_DB ?? "tina4_node";
const MONGO_URI = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const REDIS_URL = process.env.TINA4_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
// Password-protected Redis (requirepass s3cret on 6381, as in CI and the lab).
const REDIS_AUTH_URL = process.env.TINA4_TEST_REDIS_AUTH_URL ?? "redis://:s3cret@127.0.0.1:6381/3";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? " - " + detail : ""}`);
  }
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** host + port of a service URL (mongodb:// and redis:// both parse as URLs). */
function hostPort(serviceUrl: string, defaultPort: number): [string, number] {
  const parsed = new URL(serviceUrl.replace(/^mongodb\+srv:/, "mongodb:"));
  return [parsed.hostname || "127.0.0.1", parsed.port ? parseInt(parsed.port, 10) : defaultPort];
}

// ── The driverless consumer ─────────────────────────────────────────────────
// Plain JavaScript on purpose: this is the published dist, run by plain node.
// It never throws out: every case lands in `report`, printed as ONE line with
// writeSync (console.log to a pipe is async and can lose the last line).
const DRIVERLESS_CONSUMER = `
import { writeSync, mkdirSync } from "node:fs";
import net from "node:net";

const report = { cases: {}, unhandled: [], warnings: [] };
process.on("unhandledRejection", (reason) => {
  report.unhandled.push(String((reason && reason.message) || reason));
});
const originalWarn = console.warn;
console.warn = (...args) => { report.warnings.push(args.join(" ")); };

report.resolvable = ${JSON.stringify(OPTIONAL_PEERS)}.filter((name) => {
  try { import.meta.resolve(name); return true; } catch { return false; }
});

const core = await import("tina4-nodejs");
const orm = await import("tina4-nodejs/orm");

async function capture(label, action) {
  try {
    const value = await action();
    report.cases[label] = { threw: false, value: value === undefined ? null : String(value) };
  } catch (error) {
    report.cases[label] = { threw: true, message: String((error && error.message) || error) };
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
}

// 1. The app boots and serves a route.
core.get("/zd-ping", async (request, response) => response.json({ pong: true }));
const port = await freePort();
const server = await core.startServer({ port, host: "127.0.0.1" });
try {
  const ping = await fetch("http://127.0.0.1:" + server.port + "/zd-ping");
  report.ping = { status: ping.status, body: await ping.json() };
  const health = await fetch("http://127.0.0.1:" + server.port + "/health");
  report.health = health.status;
} finally {
  server.close();
}

// 2. SQLite works with nothing installed (node:sqlite).
mkdirSync("data", { recursive: true });
await capture("sqlite round-trip", async () => {
  const db = await orm.initDatabase({ url: "sqlite:///data/zero_dep.db" });
  await db.execute("CREATE TABLE IF NOT EXISTS zd_note (id INTEGER PRIMARY KEY, title TEXT)");
  await db.execute("DELETE FROM zd_note");
  await db.execute("INSERT INTO zd_note (id, title) VALUES (?, ?)", [1, "zero-dependency"]);
  const row = await db.fetchOne("SELECT title FROM zd_note WHERE id = ?", [1]);
  orm.closeDatabase();
  return row && row.title;
});

// 3. Every optional-peer feature, selected without its package.
const UNREACHABLE = "127.0.0.1:9";

await capture("postgres ORM", async () => {
  await orm.initDatabase({ url: "postgres://zd:zd@" + UNREACHABLE + "/zd" });
});
await capture("mongodb ORM", async () => {
  await orm.initDatabase({ url: "mongodb://" + UNREACHABLE + "/zd" });
});
await capture("docstore", async () => {
  process.env.TINA4_MONGO_URI = "mongodb://" + UNREACHABLE;
  try { await orm.getCollection("zd_probe"); } finally { delete process.env.TINA4_MONGO_URI; }
});
await capture("mongodb queue", async () => {
  const queue = new core.Queue({ topic: "zd", backend: "mongodb" });
  return queue.push({ hello: "world" });
});
await capture("mongodb cache", async () => {
  const backend = await core.createBackend({ backend: "mongodb", cacheUrl: "mongodb://" + UNREACHABLE + "/zd" });
  return backend.constructor.name;
});
await capture("database session on postgres", async () => {
  process.env.TINA4_DATABASE_URL = "postgres://zd:zd@" + UNREACHABLE + "/zd";
  try { return new core.DatabaseSessionHandler().read("zd-session"); }
  finally { delete process.env.TINA4_DATABASE_URL; }
});
await capture("redis websocket backplane", async () => {
  process.env.TINA4_WS_BACKPLANE = "redis";
  try { const backplane = core.createBackplane("redis://" + UNREACHABLE); return backplane && backplane.constructor.name; }
  finally { delete process.env.TINA4_WS_BACKPLANE; }
});
await capture("s3 storage", async () => {
  process.env.TINA4_STORAGE_BUCKET = "zd";
  try { return new orm.S3Storage().constructor.name; } finally { delete process.env.TINA4_STORAGE_BUCKET; }
});
await capture("s3 storage selectStorage", async () => {
  process.env.TINA4_STORAGE_BACKEND = "s3";
  process.env.TINA4_STORAGE_BUCKET = "zd";
  try { return orm.selectStorage().constructor.name; }
  finally { delete process.env.TINA4_STORAGE_BACKEND; delete process.env.TINA4_STORAGE_BUCKET; }
});

// Let any deferred rejection (a backplane connect promise) surface before reporting.
await new Promise((resolve) => setTimeout(resolve, 300));
console.warn = originalWarn;
writeSync(1, "\\n__REPORT__" + JSON.stringify(report) + "\\n");
process.exit(0);
`;

// ── The consumer after `npm install pg mongodb redis` ───────────────────────
// Each section runs only when its server was reachable (ZD_* set by the parent).
const INSTALLED_PEERS_CONSUMER = `
import { writeSync } from "node:fs";
const report = { unhandled: [] };
process.on("unhandledRejection", (reason) => {
  report.unhandled.push(String((reason && reason.message) || reason));
});
const core = await import("tina4-nodejs");
const orm = await import("tina4-nodejs/orm");

if (process.env.ZD_PG_URL) {
  try {
    const url = process.env.ZD_PG_URL;
    const db = await orm.initDatabase({ url });
    await db.execute("DROP TABLE IF EXISTS zd_peer_note");
    await db.execute("CREATE TABLE zd_peer_note (id INTEGER PRIMARY KEY, title VARCHAR(100))");
    await db.execute("INSERT INTO zd_peer_note (id, title) VALUES (?, ?)", [7, "pg installed by the app"]);
    const row = await db.fetchOne("SELECT title FROM zd_peer_note WHERE id = ?", [7]);
    report.pgTitle = row && row.title;
    await db.execute("DROP TABLE IF EXISTS zd_peer_note");
    orm.closeDatabase();

    process.env.TINA4_DATABASE_URL = url;
    const sessions = new core.DatabaseSessionHandler();
    const sessionId = "zd-" + Date.now();
    sessions.write(sessionId, { user: "peer" }, 60);
    report.pgSession = sessions.read(sessionId);
    sessions.destroy(sessionId);
    delete process.env.TINA4_DATABASE_URL;
  } catch (error) {
    report.pgError = String((error && error.stack) || error);
  }
}

if (process.env.ZD_MONGO_URI) {
  const databaseName = "tina4_zero_dep_node";
  process.env.TINA4_MONGO_URI = process.env.ZD_MONGO_URI;
  process.env.TINA4_MONGO_DB = databaseName;
  try {
    const queue = new core.Queue({ topic: "zd_peer", backend: "mongodb" });
    queue.clear();
    queue.push({ hello: "mongo installed by the app" });
    const job = queue.pop();
    report.mongoPayload = job && job.payload && job.payload.hello;
    queue.clear();
  } catch (error) {
    report.mongoError = String((error && error.stack) || error);
  } finally {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(process.env.ZD_MONGO_URI, { serverSelectionTimeoutMS: 4000 });
    try { await client.connect(); await client.db(databaseName).dropDatabase(); } finally { await client.close(); }
  }
}

if (process.env.ZD_REDIS_URL) {
  try {
    const backplane = new core.RedisBackplane(process.env.ZD_REDIS_URL);
    const channel = "tina4:zd:" + Date.now();
    const received = new Promise((resolve) => {
      backplane.subscribe(channel, resolve).then(() => backplane.publish(channel, "redis installed by the app"));
      setTimeout(() => resolve(null), 5000);
    });
    report.redisMessage = await received;
    await backplane.close();
  } catch (error) {
    report.redisError = String((error && error.stack) || error);
  }
  // NEGATIVE: an installed driver pointed at a dead server must reject the
  // caller, never crash the process with an unhandled rejection. The pause is
  // the point: a server builds its backplane at boot and may not publish for a
  // long time, so the failed connect lands while nobody is awaiting it.
  const deadBackplane = new core.RedisBackplane("redis://127.0.0.1:9");
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { await deadBackplane.publish("tina4:zd:dead", "x"); report.deadPublish = "resolved"; }
  catch (error) { report.deadPublish = "rejected"; }
}

// The backplane's own log lines must never carry the password in its URL
// (the "connected to" line printed it verbatim). The parent reads this
// process's REAL stdout and stderr for the secret.
if (process.env.ZD_REDIS_AUTH_URL) {
  try {
    const authBackplane = new core.RedisBackplane(process.env.ZD_REDIS_AUTH_URL);
    const channel = "tina4:zd:auth:" + Date.now();
    const received = new Promise((resolve) => {
      authBackplane.subscribe(channel, resolve).then(() => authBackplane.publish(channel, "redis with a password"));
      setTimeout(() => resolve(null), 5000);
    });
    report.redisAuthMessage = await received;
    await authBackplane.close();
  } catch (error) {
    report.redisAuthError = String((error && error.stack) || error);
  }
  // NEGATIVE: a WRONG password fails - and its failure line must not print it either.
  const wrongPasswordBackplane = new core.RedisBackplane(process.env.ZD_REDIS_WRONG_PASSWORD_URL);
  try { await wrongPasswordBackplane.publish("tina4:zd:wrong", "x"); report.wrongPasswordPublish = "resolved"; }
  catch (error) { report.wrongPasswordPublish = "rejected"; }
}
await new Promise((resolve) => setTimeout(resolve, 300));
writeSync(1, "\\n__REPORT__" + JSON.stringify(report) + "\\n");
process.exit(0);
`;

function runConsumer(appDir: string, file: string, extraEnv: Record<string, string> = {}, workingDirectory = appDir): { report: any; raw: string } {
  // A CONTROLLED environment: no inherited TINA4_* or driver URLs can change
  // which backend the consumer selects.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? appDir,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TINA4_NO_BROWSER: "true",
    TINA4_DEBUG: "false",
    ...extraEnv,
  };
  // stdout AND stderr, always: the framework logs to both, and a test that
  // looks for a leaked secret must read everything the process wrote.
  const child = spawnSync(process.execPath, [file], { cwd: workingDirectory, env, encoding: "utf-8", timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] });
  const raw = (child.stdout ?? "") + (child.stderr ?? "") + (child.error ? String(child.error) : "");
  const marker = raw.lastIndexOf("__REPORT__");
  if (marker < 0) return { report: null, raw };
  return { report: JSON.parse(raw.slice(marker + "__REPORT__".length).split("\n")[0]), raw };
}

console.log("\n=== Zero-dependency install (ADR-0067) - real npm pack + plain npm install, no mocks ===\n");

const workDir = mkdtempSync(join(tmpdir(), "tina4-zero-dep-"));
try {
  execFileSync("npm", ["pack", "--pack-destination", workDir], {
    cwd: rootDir, encoding: "utf-8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  });
  const tarballName = readdirSync(workDir).find((name) => name.endsWith(".tgz"));
  assert("npm pack produced a tarball", !!tarballName);
  if (!tarballName) throw new Error("no tarball");
  const tarball = join(workDir, tarballName);

  const appDir = join(workDir, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "zero-dep-consumer", version: "0.0.0", private: true, type: "module" }));

  // A PLAIN install: no --omit=optional, no --no-optional. What a user types.
  const installOutput = execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: appDir, encoding: "utf-8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`    [npm] ${installOutput.trim().split("\n").pop()}`);

  const installed = execFileSync("npm", ["ls", "--all", "--parseable"], { cwd: appDir, encoding: "utf-8" })
    .trim().split("\n").slice(1).filter(Boolean);
  assert("plain `npm install tina4-nodejs` installs exactly ONE package", installed.length === 1,
    `${installed.length} installed: ${installed.map((path) => path.split("node_modules/").pop()).join(", ")}`);
  for (const peer of OPTIONAL_PEERS) {
    assert(`optional peer '${peer}' is NOT installed`, !existsSync(join(appDir, "node_modules", peer)));
  }
  const publishedManifest = JSON.parse(readFileSync(join(appDir, "node_modules", "tina4-nodejs", "package.json"), "utf-8"));
  for (const [driver, range] of Object.entries(DECLARED_SQL_DRIVER_PEERS)) {
    assert(`published manifest declares '${driver}' as an optional peer (${range})`,
      publishedManifest.peerDependencies?.[driver] === range
        && publishedManifest.peerDependenciesMeta?.[driver]?.optional === true,
      `peerDependencies: ${JSON.stringify(publishedManifest.peerDependencies?.[driver])}, meta: ${JSON.stringify(publishedManifest.peerDependenciesMeta?.[driver])}`);
  }

  const consumer = join(appDir, "driverless.mjs");
  writeFileSync(consumer, DRIVERLESS_CONSUMER);
  const { report, raw } = runConsumer(appDir, consumer);
  assert("driverless consumer ran and reported", report !== null, raw.slice(-2000));

  if (report) {
    // The instrument, verified FIRST: if any peer resolves, nothing below proves anything.
    assert("instrument: none of the five optional peers resolve in the consumer",
      report.resolvable.length === 0, `resolvable: ${report.resolvable.join(", ")}`);

    assert("app boots and serves a registered route", report.ping?.status === 200 && report.ping?.body?.pong === true,
      JSON.stringify(report.ping));
    assert("app serves /health", report.health === 200, String(report.health));
    const sqlite = report.cases["sqlite round-trip"];
    assert("SQLite round-trip works with nothing installed", sqlite?.threw === false && sqlite?.value === "zero-dependency",
      JSON.stringify(sqlite));

    const expectThrow = (label: string, command: string): void => {
      const outcome = report.cases[label];
      assert(`${label} without its package throws`, outcome?.threw === true, JSON.stringify(outcome));
      assert(`${label} error names \`${command}\``, String(outcome?.message ?? "").includes(command), outcome?.message);
      console.log(`      ${JSON.stringify(outcome?.message ?? null)}`);
    };
    expectThrow("postgres ORM", "npm install pg");
    expectThrow("mongodb ORM", "npm install mongodb");
    expectThrow("docstore", "npm install mongodb");
    expectThrow("mongodb queue", "npm install mongodb");
    expectThrow("database session on postgres", "npm install pg");
    expectThrow("redis websocket backplane", "npm install redis");
    expectThrow("s3 storage", "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner");

    // The cache and storage selectors DEGRADE (parity with the Python master: a
    // real persistent fallback, never a silent no-op) - so the actionable text
    // must be in the warning they log, not in a throw.
    const cache = report.cases["mongodb cache"];
    assert("mongodb cache without its package falls back to the file backend",
      cache?.threw === false && cache?.value === "FileBackend", JSON.stringify(cache));
    assert("mongodb cache fallback warning names `npm install mongodb`",
      report.warnings.some((line: string) => line.includes("npm install mongodb")), JSON.stringify(report.warnings));
    const storage = report.cases["s3 storage selectStorage"];
    assert("selectStorage('s3') without its package falls back to LocalStorage",
      storage?.threw === false && storage?.value === "LocalStorage", JSON.stringify(storage));
    assert("selectStorage fallback warning names `npm install @aws-sdk/client-s3`",
      raw.includes("npm install @aws-sdk/client-s3"), raw.slice(-1500));
    for (const line of [...report.warnings, ...raw.split("\n").filter((text) => text.includes("realtime files: S3"))]) {
      console.log(`      ${JSON.stringify(line.trim())}`);
    }

    // NEGATIVE: a missing package must never escape as an unhandled rejection -
    // Node's default is to crash the whole process on one.
    assert("no unhandled rejection from any optional-peer path",
      report.unhandled.length === 0, JSON.stringify(report.unhandled));
  }

  // ── POSITIVE: the app installs the peers, and each works on a real server ──
  const [mongoHost, mongoPort] = hostPort(MONGO_URI, 27017);
  const [redisHost, redisPort] = hostPort(REDIS_URL, 6379);
  const [redisAuthHost, redisAuthPort] = hostPort(REDIS_AUTH_URL, 6381);
  const services = {
    postgres: await reachable(PG_HOST, PG_PORT),
    mongo: await reachable(mongoHost, mongoPort),
    redis: await reachable(redisHost, redisPort),
    redisAuth: await reachable(redisAuthHost, redisAuthPort),
  };
  if (!services.postgres) console.log(`  \x1b[33mSKIP\x1b[0m PostgreSQL not reachable at ${PG_HOST}:${PG_PORT} - the installed-pg round-trip did not run`);
  if (!services.mongo) console.log(`  \x1b[33mSKIP\x1b[0m MongoDB not reachable at ${mongoHost}:${mongoPort} - the installed-mongodb queue did not run`);
  if (!services.redis) console.log(`  \x1b[33mSKIP\x1b[0m Redis not reachable at ${redisHost}:${redisPort} - the installed-redis backplane did not run`);
  if (!services.redisAuth) console.log(`  \x1b[33mSKIP\x1b[0m password Redis not reachable at ${redisAuthHost}:${redisAuthPort} - the backplane log-redaction check did not run`);

  const installPeers = execFileSync("npm", ["install", "pg", "mongodb", "redis", "--no-audit", "--no-fund", "--prefer-offline"], {
    cwd: appDir, encoding: "utf-8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`    [npm install pg mongodb redis] ${installPeers.trim().split("\n").pop()}`);
  for (const peer of ["pg", "mongodb", "redis"]) {
    assert(`\`npm install ${peer}\` put ${peer} in the consumer`, existsSync(join(appDir, "node_modules", peer)));
  }

  const peersConsumer = join(appDir, "with-peers.mjs");
  writeFileSync(peersConsumer, INSTALLED_PEERS_CONSUMER);
  const peerEnv: Record<string, string> = {};
  if (services.postgres) {
    peerEnv.ZD_PG_URL = `postgres://${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASS)}@${PG_HOST}:${PG_PORT}/${PG_DB}`;
  }
  if (services.mongo) peerEnv.ZD_MONGO_URI = MONGO_URI;
  if (services.redis) peerEnv.ZD_REDIS_URL = REDIS_URL;
  const redisPassword = decodeURIComponent(new URL(REDIS_AUTH_URL).password);
  const wrongPassword = "wrong-" + redisPassword + "-zd";
  if (services.redisAuth) {
    peerEnv.ZD_REDIS_AUTH_URL = REDIS_AUTH_URL;
    const wrong = new URL(REDIS_AUTH_URL);
    wrong.password = wrongPassword;
    peerEnv.ZD_REDIS_WRONG_PASSWORD_URL = wrong.href;
  }
  // Run from OUTSIDE the app directory, as a server started from anywhere is:
  // the peers must resolve from the framework's location, not process.cwd().
  const { report: peers, raw: peersRaw } = runConsumer(appDir, peersConsumer, peerEnv, workDir);
  assert("installed-peers consumer ran and reported", peers !== null, peersRaw.slice(-2000));
  if (peers) {
    if (services.postgres) {
      assert("pg: no error", !peers.pgError, peers.pgError);
      assert("pg: real PostgreSQL round-trip through the ORM", peers.pgTitle === "pg installed by the app", JSON.stringify(peers.pgTitle));
      assert("pg: database session handler on real PostgreSQL finds the app-installed driver",
        peers.pgSession?.user === "peer", JSON.stringify(peers.pgSession));
    }
    if (services.mongo) {
      assert("mongodb: no error", !peers.mongoError, peers.mongoError);
      assert("mongodb: queue push -> pop on real MongoDB (the child process finds the app-installed driver)",
        peers.mongoPayload === "mongo installed by the app", JSON.stringify(peers.mongoPayload));
    }
    if (services.redis) {
      assert("redis: no error", !peers.redisError, peers.redisError);
      assert("redis: backplane publish -> subscribe on real Redis",
        peers.redisMessage === "redis installed by the app", JSON.stringify(peers.redisMessage));
      assert("redis: a dead server rejects publish()", peers.deadPublish === "rejected", String(peers.deadPublish));
    }
    if (services.redisAuth) {
      assert("redis with a password: backplane publish -> subscribe on real Redis",
        peers.redisAuthMessage === "redis with a password", peers.redisAuthError ?? JSON.stringify(peers.redisAuthMessage));
      const leakedLines = peersRaw.split("\n").filter((line) => line.includes(redisPassword) || line.includes(wrongPassword));
      assert("backplane_log_never_prints_the_redis_password (real stdout + stderr)", leakedLines.length === 0,
        leakedLines.slice(0, 3).join(" | "));
      assert("backplane 'connected' line still names the (redacted) target",
        peersRaw.includes(`RedisBackplane connected to redis://:***@${redisAuthHost}:${redisAuthPort}`),
        peersRaw.split("\n").filter((line) => line.includes("RedisBackplane")).join(" | "));
      assert("redis with a WRONG password: publish rejects", peers.wrongPasswordPublish === "rejected", "expected rejected authentication");
    }
    assert("installed peers: no unhandled rejection", peers.unhandled.length === 0, JSON.stringify(peers.unhandled));
  }
} catch (error) {
  assert("zero-dependency install flow completed", false, (error as Error).message);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n  Zero-dependency Install Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);
