/**
 * The SEVEN real cache providers, built through the real public factory.
 *
 * Shared by the cache-contract suites (cacheNullRoundTrip, cacheSweepCounts)
 * so "every provider" means the same seven everywhere and cannot quietly drift
 * to "the two that were convenient".
 *
 * NOTHING HERE IS A MOCK. memory is in-process by design, file writes real
 * files, database is a real SQLite file, and redis / valkey / memcached /
 * mongodb are real services over real sockets.
 *
 * Service addresses (override to point at your own containers):
 *   TINA4_TEST_REDIS_URL      (default redis://127.0.0.1:6379)
 *   TINA4_TEST_VALKEY_URL     (default valkey://127.0.0.1:6380)
 *   TINA4_TEST_MEMCACHED_URL  (default memcached://127.0.0.1:11211)
 *   TINA4_TEST_MONGO_URI      (default mongodb://127.0.0.1:27017)
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createBackend } from "../packages/core/src/index.ts";

export const REDIS_URL = process.env.TINA4_TEST_REDIS_URL ?? "redis://127.0.0.1:6379";
export const VALKEY_URL = process.env.TINA4_TEST_VALKEY_URL ?? "valkey://127.0.0.1:6380";
export const MEMCACHED_URL = process.env.TINA4_TEST_MEMCACHED_URL ?? "memcached://127.0.0.1:11211";
export const MONGO_URL = process.env.TINA4_TEST_MONGO_URI ?? "mongodb://127.0.0.1:27017";

/** A unique-per-process scratch area so two suites never share local state. */
const RUN_ID = `${process.pid}_${Date.now()}`;
export const FILE_CACHE_DIR = path.join(os.tmpdir(), `tina4_cache_inv_${RUN_ID}`);
/**
 * FOUR slashes, deliberately. `sqlite://` + an absolute path yields THREE,
 * which is the RELATIVE form (the SQLAlchemy convention Tina4 follows), so the
 * file lands under the working directory and a stray ./var/folders/... tree
 * appears in the repo. `sqlite:///` + an absolute path is the absolute form.
 */
export const SQLITE_CACHE_URL = `sqlite:///${path.join(os.tmpdir(), `tina4_cache_inv_${RUN_ID}.db`)}`;
/** Isolated mongo database so a run cannot clobber another agent's collection. */
export const MONGO_CACHE_URL = `${MONGO_URL.replace(/\/+$/, "")}/tina4_cache_inv_${RUN_ID}/cache`;

export interface ProviderSpec {
  /** Exactly what backend.name() must report - the guard against a silent fallback. */
  name: string;
  /** The config handed to the real createBackend() factory. */
  config: { backend: string; cacheUrl?: string; cacheDir?: string; maxEntries?: number };
  /** Set for the network providers so an unreachable service is reported, never skipped silently. */
  host?: string;
  port?: number;
}

function hostPort(url: string, defaultPort: number): { host: string; port: number; db: number } {
  // The DATABASE NUMBER is part of a redis URL ("redis://host:6379/4") and was
  // being dropped by .split("/")[0]. The framework then wrote into DB 4 while
  // this test counted keys on DB 0 -- a fresh connection's default -- and read
  // zero every time. Any deployment that configures a DB other than 0 had a
  // cache test silently checking the wrong database.
  const stripped = url.replace(/^[a-z+]+:\/\//, "");
  const [hostpart, dbpart] = [stripped.split("/")[0], stripped.split("/")[1]];
  const bits = hostpart.split(":");
  return {
    host: bits[0] || "127.0.0.1",
    port: bits[1] ? parseInt(bits[1], 10) || defaultPort : defaultPort,
    db: dbpart ? parseInt(dbpart, 10) || 0 : 0,
  };
}

/** Every provider the cache ships, in a stable order. */
export function providerSpecs(): ProviderSpec[] {
  const redis = hostPort(REDIS_URL, 6379);
  const valkey = hostPort(VALKEY_URL, 6379);
  const memcached = hostPort(MEMCACHED_URL, 11211);
  const mongo = hostPort(MONGO_URL, 27017);
  return [
    { name: "memory", config: { backend: "memory" } },
    { name: "file", config: { backend: "file", cacheDir: FILE_CACHE_DIR } },
    { name: "database", config: { backend: "database", cacheUrl: SQLITE_CACHE_URL } },
    { name: "redis", config: { backend: "redis", cacheUrl: REDIS_URL }, ...redis },
    { name: "valkey", config: { backend: "valkey", cacheUrl: VALKEY_URL }, ...valkey },
    { name: "memcached", config: { backend: "memcached", cacheUrl: MEMCACHED_URL }, ...memcached },
    { name: "mongodb", config: { backend: "mongodb", cacheUrl: MONGO_CACHE_URL }, ...mongo },
  ];
}

/** Real TCP reachability probe. Local providers are always reachable. */
export function reachable(spec: ProviderSpec): Promise<boolean> {
  if (spec.host === undefined || spec.port === undefined) return Promise.resolve(true);
  const { host, port } = spec;
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port }, () => { sock.destroy(); resolve(true); });
    sock.on("error", () => resolve(false));
    const timer = setTimeout(() => { try { sock.destroy(); } catch { /* noop */ } resolve(false); }, 2000);
    if (timer.unref) timer.unref();
  });
}

/**
 * Build a provider through the REAL factory and refuse a silent downgrade.
 *
 * createBackend() falls back to the file backend when a service is unreachable,
 * so without this check every network assertion would quietly pass against
 * local disk and prove nothing about redis/valkey/memcached/mongodb.
 */
export async function makeReal(spec: ProviderSpec): Promise<any> {
  const made: any = await createBackend(spec.config);
  if (made.name() !== spec.name) {
    throw new Error(
      `createBackend('${spec.config.backend}') returned '${made.name()}' - the service was ` +
      "unreachable and the cache fell back; these assertions would prove nothing",
    );
  }
  return made;
}
