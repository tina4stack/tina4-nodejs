/**
 * SESSION CONTRACT: the session key prefix is configurable by env var, on every
 * RESP backend.
 *
 * ADR-0024: swapping one session backend for another changes ONE env var and
 * nothing else. Namespacing the keys those backends write is part of that
 * configuration surface, and it was present in ONE framework out of four.
 *
 * WHY THIS FILE EXISTS. Measured 2026-08-05 across all four frameworks:
 *
 *     TINA4_SESSION_MEMCACHED_PREFIX   python YES  php YES  ruby YES  node YES
 *     TINA4_SESSION_VALKEY_PREFIX      python no   php no   ruby YES  node YES
 *     TINA4_SESSION_REDIS_PREFIX       python no   php no   ruby no   node YES
 *
 * Node was the only framework that honoured BOTH, so it is the reference the
 * other three were brought up to - and this file is the lock-in that keeps Node
 * from drifting the other way. Without it, "nobody tests this in Node" is how
 * the leader quietly becomes the laggard.
 *
 * NO MOCKS. Both backends are the real service, and every claim about the key's
 * NAME is checked over a RESP socket THIS TEST owns - never by asking the
 * handler what it thinks it wrote. A handler that lies consistently would pass
 * a self-report; it cannot pass this.
 *
 * THE CONFIG KEYS ARE NOT UNIFORM, and case 4 pins that rather than hiding it.
 * RedisSessionHandler reads redisHost / redisPort / redisDb / redisPrefix while
 * ValkeySessionHandler reads host / port / db / prefix. One uniform config object is
 * therefore WRONG for exactly one of the two, and the wrong key is silently
 * ignored - a handler pointed nowhere dials the real default instead, and a
 * test written that way passes while measuring nothing. That exact trap already
 * produced a false green in sessionHandlerConstruction.
 *
 * THE FOUR CASES, and why each is load-bearing:
 *   1. positive   - the env var really names the key ON THE SERVER.
 *   2. precedence - an explicit option still beats the env var. Without it,
 *                   "always read the env var" passes case 1 and breaks every
 *                   caller passing the prefix explicitly.
 *   3. negative   - with nothing set the default is still "tina4:session:".
 *                   Without it, "always prepend the variable, empty or not"
 *                   passes 1 and 2 and renames every existing key in every
 *                   deployment that never asked for a prefix - which on a
 *                   session store logs everybody out at once.
 *   4. config keys - each handler really reads ITS OWN spelling, so a future
 *                   uniform-config refactor cannot silently half-apply.
 */
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { RedisSessionHandler } from "../packages/core/src/session.js";
import { ValkeySessionHandler } from "../packages/core/src/sessionHandlers/valkeyHandler.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass += 1;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
  }
}

const REQUIRE_SERVICES = Boolean(process.env.TINA4_REQUIRE_SERVICES);

/**
 * Each backend with the config keys ITS handler reads. `build` exists precisely
 * so the two spellings stay explicit instead of being smoothed into one object
 * that would be wrong for one of them.
 */
const BACKENDS = [
  {
    name: "redis",
    host: process.env.TINA4_SESSION_REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.TINA4_SESSION_REDIS_PORT ?? 6379),
    db: Number(process.env.TINA4_SESSION_REDIS_DB ?? 0),
    env: "TINA4_SESSION_REDIS_PREFIX",
    configKey: "redisPrefix",
    build: (host: string, port: number, db: number, prefix?: string) =>
      new RedisSessionHandler({
        redisHost: host,
        redisPort: port,
        redisDb: db,
        ...(prefix === undefined ? {} : { redisPrefix: prefix }),
      } as never),
  },
  {
    name: "valkey",
    host: process.env.TINA4_SESSION_VALKEY_HOST ?? "127.0.0.1",
    port: Number(process.env.TINA4_SESSION_VALKEY_PORT ?? 6380),
    db: Number(process.env.TINA4_SESSION_VALKEY_DB ?? 0),
    env: "TINA4_SESSION_VALKEY_PREFIX",
    configKey: "prefix",
    build: (host: string, port: number, db: number, prefix?: string) =>
      new ValkeySessionHandler({
        host,
        port,
        db,
        ...(prefix === undefined ? {} : { prefix }),
      } as never),
  },
] as const;

const DEFAULT_PREFIX = "tina4:session:";

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/** One RESP command over OUR socket, in the SAME db the handler wrote to. */
function respCommand(host: string, port: number, db: number, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let buffer = "";
    const finish = (action: () => void) => { socket.destroy(); action(); };
    socket.setTimeout(3000);
    const encode = (parts: string[]) =>
      `*${parts.length}\r\n` + parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("");
    socket.once("connect", () => {
      // SELECT is pipelined ahead of the command, so the server sends TWO
      // replies and the one we want is the SECOND. A fresh connection is always
      // db 0 - without this the probe reads a database nobody wrote to.
      if (db > 0) socket.write(encode(["SELECT", String(db)]));
      socket.write(encode(args));
    });
    const wanted = db > 0 ? 2 : 1;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\r\n").filter((l) => l.length > 0);
      if (lines.length < wanted) return;
      if (db > 0 && !lines[0].startsWith("+OK")) {
        return finish(() => reject(new Error(`SELECT ${db} refused: ${JSON.stringify(lines[0])}`)));
      }
      finish(() => resolve(lines[wanted - 1]));
    });
    socket.once("error", (err) => finish(() => reject(err)));
    socket.once("timeout", () => finish(() => reject(new Error("RESP probe timed out"))));
  });
}

async function keyOnServer(host: string, port: number, db: number, key: string): Promise<boolean> {
  const reply = await respCommand(host, port, db, ["EXISTS", key]);
  if (!reply.startsWith(":")) throw new Error(`unexpected EXISTS reply ${JSON.stringify(reply)}`);
  return Number(reply.slice(1)) === 1;
}

async function del(host: string, port: number, db: number, keys: string[]): Promise<void> {
  for (const key of keys) {
    try { await respCommand(host, port, db, ["DEL", key]); } catch { /* cleanup is best effort */ }
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

console.log("\n== session key prefix ==\n");

for (const backend of BACKENDS) {
  const { name, host, port, db, env, configKey, build } = backend;
  const saved = process.env[env];

  if (!(await reachable(host, port))) {
    const message = `${name} not reachable at ${host}:${port}`;
    if (REQUIRE_SERVICES) {
      assert(`session_key_prefix_env_var_names_the_key_on_the_server [${name}]`, false, message);
    } else {
      console.log(`  \x1b[33mSKIP\x1b[0m ${message}`);
    }
    continue;
  }

  try {
    // -- 1. POSITIVE -------------------------------------------------------
    const configured = `itest${randomBytes(4).toString("hex")}:`;
    setEnv(env, configured);
    let id = `prefix-${randomBytes(4).toString("hex")}`;
    build(host, port, db).write(id, { seeded: true }, 60);
    const atConfigured = await keyOnServer(host, port, db, `${configured}${id}`);
    const alsoAtDefault = await keyOnServer(host, port, db, `${DEFAULT_PREFIX}${id}`);
    assert(
      `session_key_prefix_env_var_names_the_key_on_the_server [${name}]`,
      atConfigured && !alsoAtDefault,
      `${env}=${configured} | at configured key: ${atConfigured} | `
      + `ALSO at the default key (prefix appended rather than used): ${alsoAtDefault}`,
    );
    await del(host, port, db, [`${configured}${id}`, `${DEFAULT_PREFIX}${id}`]);

    // -- 2. PRECEDENCE -----------------------------------------------------
    setEnv(env, "fromenv:");
    const explicit = `explicit${randomBytes(4).toString("hex")}:`;
    id = `prefix-${randomBytes(4).toString("hex")}`;
    build(host, port, db, explicit).write(id, { seeded: true }, 60);
    const atExplicit = await keyOnServer(host, port, db, `${explicit}${id}`);
    const atEnv = await keyOnServer(host, port, db, `fromenv:${id}`);
    assert(
      `session_key_prefix_option_wins_over_the_env_var [${name}]`,
      atExplicit && !atEnv,
      `an explicit ${configKey} must beat ${env} | at explicit: ${atExplicit} | at env prefix: ${atEnv}`,
    );
    await del(host, port, db, [`${explicit}${id}`, `fromenv:${id}`]);

    // -- 3. NEGATIVE CONTROL ----------------------------------------------
    setEnv(env, undefined);
    id = `prefix-${randomBytes(4).toString("hex")}`;
    build(host, port, db).write(id, { seeded: true }, 60);
    const atDefault = await keyOnServer(host, port, db, `${DEFAULT_PREFIX}${id}`);
    assert(
      `session_key_prefix_defaults_when_nothing_is_set [${name}]`,
      atDefault,
      `with ${env} unset the key must still be ${DEFAULT_PREFIX}<id>, and nothing was there`,
    );
    await del(host, port, db, [`${DEFAULT_PREFIX}${id}`]);

    // -- 4. THE CONFIG KEY THIS HANDLER ACTUALLY READS ---------------------
    //
    // Pass the OTHER handler's spelling and prove it is IGNORED. If a future
    // refactor made both accept one uniform object, this case fails loudly
    // rather than letting a half-applied rename pass silently.
    const wrongKey = configKey === "prefix" ? "redisPrefix" : "prefix";
    setEnv(env, undefined);
    id = `prefix-${randomBytes(4).toString("hex")}`;
    const handler = configKey === "prefix"
      ? new ValkeySessionHandler({ host, port, db, [wrongKey]: "wrong:" } as never)
      : new RedisSessionHandler({ redisHost: host, redisPort: port, redisDb: db, [wrongKey]: "wrong:" } as never);
    handler.write(id, { seeded: true }, 60);
    const atWrong = await keyOnServer(host, port, db, `wrong:${id}`);
    const atDefaultStill = await keyOnServer(host, port, db, `${DEFAULT_PREFIX}${id}`);
    assert(
      `session_key_prefix_reads_this_handlers_own_config_key [${name}]`,
      !atWrong && atDefaultStill,
      `${name} reads ${configKey}, not ${wrongKey} | honoured the wrong key: ${atWrong} | `
      + `fell back to the default as it should: ${atDefaultStill}`,
    );
    await del(host, port, db, [`wrong:${id}`, `${DEFAULT_PREFIX}${id}`]);
  } finally {
    setEnv(env, saved);
  }
}

console.log(
  `\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m\n`,
);
if (fail > 0) process.exitCode = 1;
