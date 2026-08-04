/**
 * Tina4 synchronous SQL transport for the database session backend.
 *
 * WHY IT EXISTS. The SessionHandler interface is SYNCHRONOUS and every SQL
 * driver Node offers for a networked engine (pg, mysql2, tedious,
 * node-firebird) is async-only. That mismatch was previously "resolved" by
 * refusing every engine except SQLite: resolveDbPath() THREW on any non-sqlite
 * TINA4_DATABASE_URL. So an app developed on SQLite and deployed on PostgreSQL
 * did not start, in the one subsystem that decides whether anybody is logged in.
 *
 * The mismatch is not a reason to refuse an engine, because the fix already
 * existed: syncBridge.ts. A Worker thread keeps its own event loop, so it can
 * hold a long-lived driver connection and do ordinary async I/O, while the
 * caller blocks in Atomics.wait until the worker writes its reply into a
 * SharedArrayBuffer. RESP (Redis/Valkey), memcached and MongoDB have all ridden
 * that bridge for months. This is a fifth consumer of a proven mechanism, not a
 * new mechanism.
 *
 * SQLITE DOES NOT COME THROUGH HERE. `node:sqlite` is already synchronous, so
 * routing it through a worker would add a thread hop and a JSON round-trip to
 * the one engine that needs neither. DatabaseSessionHandler drives it directly.
 *
 * WHY THE DRIVERS ARE REQUIRED INSIDE THE WORKER rather than reaching for the
 * ORM adapters: exactly the reason mongoClient.ts requires "mongodb" itself.
 * The worker body is an eval'd CJS string, so a bare `require` is the one module
 * resolution that works identically under tsx, under plain node, from source and
 * from a built dist. @tina4/orm already declares pg / mysql2 / tedious as
 * optional dependencies, so nothing new is installed for this - core stays
 * zero-dependency.
 *
 * The SQL itself is NOT built here. The handler builds engine-neutral SQL with
 * `?` placeholders - the same statement text as the Python master - and this
 * transport rewrites the placeholders into the dialect the driver wants. Only
 * the placeholder style and the CREATE TABLE types differ per engine.
 */
import { createRequire } from "node:module";
import { getBridge, STATUS_OK, STATUS_TRANSPORT } from "./syncBridge.js";

/**
 * The SQL engines the database session backend speaks.
 *
 * This IS the invariant: it is the engine set of the ORM Database layer minus
 * the two non-SQL entries (mongodb has its own session backend, odbc has no
 * session story in any of the four frameworks). Naming it once means the
 * refusal message and the dispatch can never disagree about what is supported.
 */
export const SQL_SESSION_ENGINES = ["sqlite", "postgres", "mysql", "mssql", "firebird"] as const;

export type SqlSessionEngine = (typeof SQL_SESSION_ENGINES)[number];

/** The engines that need the bridge - everything except already-sync SQLite. */
export type BridgedEngine = Exclude<SqlSessionEngine, "sqlite">;

/**
 * A connection target for the worker.
 *
 * A PLAIN object, deliberately - never a `DatabaseUrl`. That class carries a
 * cleartext password and its own docblock forbids persisting it across a
 * structured-clone boundary (test/databaseUrlRedaction.test.ts enforces it).
 * The worker genuinely needs credentials to authenticate, so it gets the fields
 * it needs and nothing that renders itself.
 */
export interface SqlTarget {
  engine: BridgedEngine;
  host: string;
  port: number;
  database: string;
  username: string | null;
  password: string | null;
}

/**
 * Connect budget, kept BELOW the bridge's 5s reply timeout on purpose. An
 * unreachable server then surfaces as a real driver message ("ECONNREFUSED
 * 127.0.0.1:5432") instead of the caller's generic "timed out after 5000ms",
 * which says nothing about what is actually wrong. Same reasoning, same number
 * as mongoClient's SERVER_SELECTION_MS.
 */
const CONNECT_TIMEOUT_MS = 3000;

/** The driver each engine needs. All are already optional deps of @tina4/orm. */
const DRIVER_PACKAGE: Record<BridgedEngine, string> = {
  postgres: "pg",
  mysql: "mysql2",
  mssql: "tedious",
  firebird: "node-firebird",
};

const requireFromHere = createRequire(import.meta.url);

/**
 * Resolve the driver to an ABSOLUTE path, on the main thread, before the worker
 * starts.
 *
 * A bare `require("pg")` inside the worker would resolve from the process
 * WORKING DIRECTORY (an eval'd worker has no real filename to resolve from), so
 * a server started from anywhere other than the project root would fail to find
 * a driver that is installed. Resolving from THIS module instead walks up from
 * the framework's own location, which is correct in the monorepo and in an
 * installed app alike.
 *
 * @throws Error naming the missing package and how to install it.
 */
function driverPath(engine: BridgedEngine): string {
  const packageName = DRIVER_PACKAGE[engine];
  try {
    return requireFromHere.resolve(packageName);
  } catch {
    throw new Error(
      `The "database" session backend on ${engine} requires the "${packageName}" package. `
      + `Install it with: npm install ${packageName}`,
    );
  }
}

const SQL_WORKER = `
const target = workerData.target;
const engine = target.engine;
const driver = require(workerData.driverPath);

let client = null;

/**
 * Rewrite the handler's neutral \`?\` placeholders into the driver's dialect.
 * mysql2 and node-firebird already take \`?\`, so they are left alone.
 */
function convert(sql) {
  if (engine === "postgres") { let n = 0; return sql.replace(/\\?/g, () => "$" + (++n)); }
  if (engine === "mssql") { let n = 0; return sql.replace(/\\?/g, () => "@p" + (n++)); }
  return sql;
}

async function connect() {
  if (engine === "postgres") {
    const Client = driver.Client || (driver.default && driver.default.Client);
    const c = new Client({
      host: target.host,
      port: target.port,
      user: target.username === null ? undefined : target.username,
      password: target.password === null ? undefined : target.password,
      database: target.database,
      connectionTimeoutMillis: ${CONNECT_TIMEOUT_MS},
    });
    await c.connect();
    return c;
  }
  if (engine === "mysql") {
    const c = driver.createConnection({
      host: target.host,
      port: target.port,
      user: target.username === null ? undefined : target.username,
      password: target.password === null ? undefined : target.password,
      database: target.database,
      connectTimeout: ${CONNECT_TIMEOUT_MS},
    });
    await new Promise((resolve, reject) => c.connect((err) => (err ? reject(err) : resolve())));
    return c;
  }
  if (engine === "mssql") {
    const c = new driver.Connection({
      server: target.host,
      authentication: {
        type: "default",
        options: { userName: target.username, password: target.password },
      },
      options: {
        database: target.database,
        port: target.port,
        trustServerCertificate: true,
        encrypt: false,
        connectTimeout: ${CONNECT_TIMEOUT_MS},
      },
    });
    await new Promise((resolve, reject) => {
      c.on("connect", (err) => (err ? reject(err) : resolve()));
      c.connect();
    });
    return c;
  }
  if (engine === "firebird") {
    return await new Promise((resolve, reject) => {
      driver.attach(
        {
          host: target.host,
          port: target.port,
          database: target.database,
          user: target.username,
          password: target.password,
        },
        (err, db) => (err ? reject(err) : resolve(db)),
      );
    });
  }
  throw new Error("unsupported session SQL engine: " + engine);
}

function runMssql(sql, params) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const request = new driver.Request(convert(sql), (err) => (err ? reject(err) : resolve(rows)));
    params.forEach((value, i) => {
      // EVERY number binds as Float, never Int. tedious' Int is 32-bit and an
      // expiry stamp is epoch SECONDS - an integral value above 2147483647
      // (2038-01-19) would overflow and be stored as garbage, silently.
      if (typeof value === "number") request.addParameter("p" + i, driver.TYPES.Float, value);
      else if (value === null || value === undefined) request.addParameter("p" + i, driver.TYPES.NVarChar, null);
      // length: Infinity means NVARCHAR(MAX). Without it tedious caps the
      // parameter at 4000 characters and a large session TRUNCATES on write.
      else request.addParameter("p" + i, driver.TYPES.NVarChar, String(value), { length: Infinity });
    });
    request.on("row", (columns) => {
      const row = {};
      columns.forEach((column) => { row[column.metadata.colName] = column.value; });
      rows.push(row);
    });
    client.execSql(request);
  });
}

async function run(sql, params) {
  if (!client) client = await connect();
  if (engine === "postgres") {
    const result = await client.query(convert(sql), params);
    return result.rows || [];
  }
  if (engine === "mysql") {
    const results = await new Promise((resolve, reject) => {
      client.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    return Array.isArray(results) ? results : [];
  }
  if (engine === "mssql") return await runMssql(sql, params);
  const rows = await new Promise((resolve, reject) => {
    client.query(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
  });
  return Array.isArray(rows) ? rows : [];
}

parentPort.on("message", (message) => {
  void (async () => {
    try {
      const rows = await run(message.sql, message.params || []);
      __reply(${STATUS_OK}, JSON.stringify(rows));
    } catch (err) {
      // Drop the connection so the NEXT command reconnects. A transient blip
      // must not poison the channel for the life of the process.
      try {
        if (client) {
          if (typeof client.end === "function") client.end();
          else if (typeof client.close === "function") client.close();
          else if (typeof client.detach === "function") client.detach();
        }
      } catch (ignored) {}
      client = null;
      __reply(${STATUS_TRANSPORT}, String((err && err.message) || err));
    }
  })();
});
`;

/**
 * Run one SQL statement synchronously against a networked engine.
 *
 * @returns the result rows - always an array, empty for a write or DDL.
 * @throws Error on ANY driver failure (server unreachable, bad credentials,
 *         SQL error). It is never swallowed into an empty result: for a session
 *         store, "the database is down" and "no session yet" must stay
 *         distinguishable, or a dead backend silently logs every user out.
 */
export function sqlCommandSync(
  target: SqlTarget,
  sql: string,
  params: unknown[] = [],
  label = "Database session",
): Record<string, unknown>[] {
  const key = `sql:${target.engine}:${target.host}:${target.port}:${target.database}:${target.username ?? ""}`;
  const { status, payload } = getBridge(key, SQL_WORKER, {
    target,
    driverPath: driverPath(target.engine),
  }).call({ sql, params }, label);

  if (status !== STATUS_OK) {
    throw new Error(`${label} command failed: ${payload}`);
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>[];
  } catch {
    return [];
  }
}
