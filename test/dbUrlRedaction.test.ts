/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * GHSA-h2mr-m3v3-cq8c - a connection URL's password never reaches output,
 * whatever shape the URL has.
 *
 * Driven by test/fixtures/db_url_redaction_cases.json, the case list shared by
 * all four frameworks: every password x every template x every scheme each
 * parser supports, through the REAL code:
 *
 *   redact   redactCredentials() - the single redaction primitive, and the
 *            function the websocket backplane's "connected to" line uses
 *   parse    DatabaseUrl, GraphUrl, Mqtt.parseUrl, parseAmqpUrl
 *   connect  initDatabase (pg, mysql2, tedious, node-firebird, mongodb),
 *            GraphDatabase + query (ultipa, neo4j-driver, arangojs), Mqtt.connect,
 *            RabbitMQBackend.push, the Mongo DocStore, the Redis websocket
 *            backplane - every one against a CLOSED 127.0.0.1 port, so each
 *            fails for real
 *   boot     real startServer() children with TINA4_DATABASE_URL set (the
 *            "Database could not be reached" boot line) for every template x
 *            three passwords, plus the dev admin's GET /__dev/api/connections
 *            for every case
 *
 * No mocks. Process output is CAPTURED (stdout/stderr writes) while each
 * framework call runs, and every captured byte is scanned too.
 *
 * "No output contains a secret fragment" means: the return value, the parsed
 * non-secret fields (host, user, database, the safe/JSON/inspect renders),
 * error.message, error.stack, util.inspect(error) - which walks own properties
 * such as Node's TypeError `.input` - and the whole `cause` chain, plus all
 * captured stdout/stderr.
 *
 * KNOWN LIMITS (documented, asserted to be the ONLY exclusions):
 *   - A host-less URL whose password is all digits (postgres://u:123/x) is a
 *     valid URL with port 123. Not in the case list.
 *   - `{scheme}://u:Pq1@Rs2` (the host-less template with a password holding an
 *     unencoded `@`) is byte-for-byte a valid URL whose HOST is `Rs2`. Nothing
 *     can tell it from `postgres://u:pw@dbhost`, so the "host" is shown and a
 *     connect looks it up. Skipped on every surface, and counted, so the
 *     exclusion cannot silently grow.
 *
 * sqlite and odbc are not swept: a sqlite URL is a file path with no userinfo,
 * and odbc carries PWD= (covered by test/databaseUrlRedaction.test.ts).
 *
 * Run with: npx tsx test/dbUrlRedaction.test.ts
 */
import { inspect } from "node:util";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { freePort } from "./freePort.ts";

// Bound every connect so a run stays fast; a refused port answers in ms anyway.
process.env.TINA4_DATABASE_CONNECT_TIMEOUT = "2";
process.env.TINA4_GRAPH_CONNECT_TIMEOUT = "2";
delete process.env.TINA4_DB_POOL;
delete process.env.TINA4_DATABASE_USERNAME;
delete process.env.TINA4_DATABASE_PASSWORD;

const { DatabaseUrl, redactCredentials } = await import("../packages/orm/src/databaseUrl.ts");
const { initDatabase } = await import("../packages/orm/src/database.ts");
const { GraphUrl } = await import("../packages/orm/src/graph/graphUrl.ts");
const { GraphDatabase } = await import("../packages/orm/src/graph/graphDatabase.ts");
const { Mqtt } = await import("../packages/core/src/mqtt.ts");
const { parseAmqpUrl, RabbitMQBackend } = await import("../packages/core/src/queueBackends/rabbitmqBackend.ts");
const { getCollection, closeDocStore } = await import("../packages/orm/src/docstore.ts");

interface MustParse { url: string; host: string; port?: number; user: string; password: string; database: string }
const CASES = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "db_url_redaction_cases.json"), "utf8"),
) as { secret_fragments: string[]; passwords: string[]; templates: string[]; must_still_parse: MustParse[] };
const FRAGMENTS = CASES.secret_fragments;

// ── bookkeeping ────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const failsBySurface = new Map<string, number>();
const groupPass = new Map<string, number>();

/** One assertion. PASS lines are folded per group (thousands of cases); every FAIL prints. */
function check(group: string, name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    groupPass.set(group, (groupPass.get(group) ?? 0) + 1);
    return;
  }
  fail++;
  const surface = group.split(" ")[0];
  failsBySurface.set(surface, (failsBySurface.get(surface) ?? 0) + 1);
  console.log(`  \x1b[31mFAIL\x1b[0m [${group}] ${name} ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
}

function flushGroup(group: string): void {
  const n = groupPass.get(group) ?? 0;
  if (n > 0) console.log(`  \x1b[32mPASS\x1b[0m [${group}] ${n} case(s)`);
  groupPass.delete(group);
}

const leakIn = (text: string): string | null => FRAGMENTS.find((f) => text.includes(f)) ?? null;

/** Every surface an error offers: message, stack, inspect (own props) and the cause chain. */
function errorSurfaces(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      parts.push(String(cur.message), String(cur.stack ?? ""));
      if (cur instanceof AggregateError) for (const e of cur.errors) parts.push(errorSurfaces(e));
    } else {
      parts.push(String(cur));
    }
    try { parts.push(inspect(cur, { depth: 6, showHidden: false })); } catch { /* unrenderable */ }
    cur = (cur as { cause?: unknown })?.cause;
  }
  return parts.join("\n");
}

/** Capture every stdout/stderr write made while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  let out = "";
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const grab = (chunk: unknown): boolean => { out += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString(); return true; };
  (process.stdout as any).write = grab;
  (process.stderr as any).write = grab;
  try {
    const value = await fn();
    return { value, out };
  } finally {
    (process.stdout as any).write = origOut;
    (process.stderr as any).write = origErr;
  }
}

// ── the case matrix ────────────────────────────────────────────────────────

const KNOWN_LIMIT_TEMPLATE = "{scheme}://u:{pw}";
const KNOWN_LIMIT_PASSWORD = "Pq1@Rs2";
let knownLimitSkips = 0;

interface Case { scheme: string; template: string; pw: string; url: string; hasHost: boolean; known: boolean }

function casesFor(scheme: string): Case[] {
  const out: Case[] = [];
  for (const template of CASES.templates) {
    for (const pw of CASES.passwords) {
      out.push({
        scheme, template, pw,
        url: template.replace("{scheme}", scheme).replace("{pw}", pw),
        hasHost: template.includes("dbhost"),
        known: template === KNOWN_LIMIT_TEMPLATE && pw === KNOWN_LIMIT_PASSWORD,
      });
    }
  }
  return out;
}

/** Point a case at a CLOSED loopback port; the credential shape is untouched. */
function toLoopback(url: string, port: number): string {
  return url
    .replace("dbhost:5432", `127.0.0.1:${port}`)
    .replace("dbhost:notaport", "127.0.0.1:notaport")
    .replace("dbhost", `127.0.0.1:${port}`);
}

const DB_SCHEMES = ["postgres", "postgresql", "pgsql", "mysql", "mssql", "sqlserver", "firebird", "mongodb", "mongodb+srv"];
const GRAPH_SCHEMES = ["ultipa", "ultipas", "neo4j", "neo4j+s", "bolt", "bolt+s", "memgraph", "arango", "arangodb"];
const MQTT_SCHEMES = ["mqtt", "tcp", "mqtts"];
const AMQP_SCHEMES = ["amqp", "amqps"];
/** Redact-only: the backplane prints these through redactCredentials(). */
const REDACT_ONLY_SCHEMES = ["redis", "rediss", "nats"];

const closedPort = await freePort();
const T0 = Date.now();
const elapsed = (): string => `${((Date.now() - T0) / 1000).toFixed(1)}s`;

// ── 5a. boot children, started now so they overlap the in-process sections ──
// One real startServer() per URL is the slow part of this file (a tsx child
// each), and the runner allows a file 60s. The boot LOG is driven for every
// template with three passwords, each defeating one of the old rules: `/` (the
// stock regex could not cross it), a space (nor that), and a digit-led one
// that looks like a port. The dev admin's GET covers EVERY case, from one boot.
const REPO = resolve(import.meta.dirname, "..");
const SERVER_URL = pathToFileURL(join(REPO, "packages/core/src/index.ts")).href;
const bootRoots: string[] = [];
const BOOT_PASSWORDS = ["Pq1/Rs2", "Pq1 Rs2", "12?Pq1Rs2"].filter((pw) => CASES.passwords.includes(pw));

async function bootOnce(
  databaseUrl: string,
  saveRoundTrip = false,
  envSweep: string[] = [],
): Promise<{ log: string; connections: string; savedEnv: string; sweep: { url: string; body: string }[] }> {
  const root = mkdtempSync(join(tmpdir(), "tina4-ghsa-boot-"));
  bootRoots.push(root);
  mkdirSync(join(root, "src/orm"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  // The dev admin reads TINA4_DATABASE_URL straight out of .env.
  writeFileSync(join(root, ".env"), `TINA4_DATABASE_URL=${databaseUrl}\n`);
  writeFileSync(join(root, "server.ts"), `
import { startServer } from ${JSON.stringify(SERVER_URL)};
process.chdir(${JSON.stringify(root)});
await startServer({ port: Number(process.env.PORT), basePath: ${JSON.stringify(root)} });
console.log("TEST-SERVER-READY");
`);
  const port = await freePort();
  const env: Record<string, string | undefined> = {
    ...process.env, PORT: String(port), TINA4_DEBUG: "true", TINA4_LOG_LEVEL: "DEBUG",
    TINA4_NO_BROWSER: "true", TINA4_NO_AI_PORT: "true", TINA4_OVERRIDE_CLIENT: "true",
    TINA4_DATABASE_URL: databaseUrl, TINA4_CSRF: "false",
  };
  delete env.TINA4_AUTO_MIGRATE;
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", join(root, "server.ts")], {
    cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout!.on("data", (b) => { log += b; });
  child.stderr!.on("data", (b) => { log += b; });
  let connections = "";
  let savedEnv = "";
  const sweep: { url: string; body: string }[] = [];
  try {
    const ready = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 90000);
      const tick = setInterval(() => {
        if (log.includes("TEST-SERVER-READY")) { clearInterval(tick); clearTimeout(timer); done(true); }
      }, 50);
      child.on("exit", () => { clearInterval(tick); clearTimeout(timer); done(false); });
    });
    if (ready) {
      const getConnections = () => new Promise<string>((done) => {
        http.get({ host: "127.0.0.1", port, path: "/__dev/api/connections", agent: false }, (res) => {
          let body = "";
          res.on("data", (b) => { body += b; });
          res.on("end", () => done(`${res.statusCode} ${body}`));
        }).on("error", (e) => done(`request failed: ${e.message}`));
      });
      connections = await getConnections();
      if (saveRoundTrip) {
        // A UI that posts the GET's (redacted) url straight back must not
        // write *** over the real password.
        let served = "";
        try { served = JSON.parse(connections.slice(4)).url; } catch { served = ""; }
        const payload = JSON.stringify({ url: served, username: "", password: "" });
        await new Promise<void>((done) => {
          const req = http.request({
            host: "127.0.0.1", port, path: "/__dev/api/connections/save", method: "POST", agent: false,
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          }, (res) => { res.resume(); res.on("end", () => done()); });
          req.on("error", () => done());
          req.end(payload);
        });
        try { savedEnv = readFileSync(join(root, ".env"), "utf8"); } catch { savedEnv = ""; }
      }
      // The handler re-reads .env on every request, so one server serves the
      // whole case list: rewrite .env, GET, repeat.
      for (const url of envSweep) {
        writeFileSync(join(root, ".env"), `TINA4_DATABASE_URL=${url}\n`);
        sweep.push({ url, body: await getConnections() });
      }
    }
  } finally {
    child.kill("SIGKILL");
  }
  return { log, connections, savedEnv, sweep };
}


const bootCases = casesFor("postgres").filter((c) => !c.known && BOOT_PASSWORDS.includes(c.pw));
const allPostgresUrls = casesFor("postgres").filter((c) => !c.known).map((c) => toLoopback(c.url, closedPort));
const bootResults = Promise.all(bootCases.map(async (c, i) => {
  const url = toLoopback(c.url, closedPort);
  const roundTrip = i === 0;
  return { c, url, roundTrip, ...(await bootOnce(url, roundTrip, i === 0 ? allPostgresUrls : [])) };
}));

console.log("=== GHSA-h2mr-m3v3-cq8c: connection URL redaction ===\n");

// ── 1. redact ──────────────────────────────────────────────────────────────
console.log(`--- redact: redactCredentials() never returns a fragment, keeps scheme/user/host --- (${elapsed()})`);
for (const scheme of [...DB_SCHEMES, ...GRAPH_SCHEMES, ...MQTT_SCHEMES, ...AMQP_SCHEMES, ...REDACT_ONLY_SCHEMES]) {
  const group = `redact ${scheme}`;
  for (const c of casesFor(scheme)) {
    if (c.known) { knownLimitSkips++; continue; }
    const out = redactCredentials(c.url);
    const leak = leakIn(out);
    check(group, `${c.url}`, leak === null, `-> ${out}`);
    const keeps = out.includes(scheme) && out.includes("u") && (!c.hasHost || out.includes("dbhost"));
    check(group, `${c.url} keeps scheme/user/host`, keeps, `-> ${out}`);
  }
  flushGroup(group);
}

// ── 2. parse ───────────────────────────────────────────────────────────────

/**
 * Run a parser on one case. Refusal: the error must be clean. Acceptance: every
 * non-secret field must be clean AND the password must be the one written (a
 * parser that splits at the wrong `@`/`/` is how a fragment lands in a host).
 */
async function parseCase(
  group: string,
  c: Case,
  parse: (url: string) => { fields: string; password: string | null; host: string | null },
): Promise<void> {
  const { value: result, out } = await captured(async () => {
    try { return { ok: true as const, parsed: parse(c.url) }; } catch (err) { return { ok: false as const, err }; }
  });
  check(group, `${c.url} [output]`, leakIn(out) === null, out);
  if (!result.ok) {
    const surfaces = errorSurfaces(result.err);
    check(group, `${c.url} [refusal is clean]`, leakIn(surfaces) === null, surfaces);
    return;
  }
  check(group, `${c.url} [parsed fields are clean]`, leakIn(result.parsed.fields) === null, result.parsed.fields);
  check(group, `${c.url} [password split correctly]`, result.parsed.password === c.pw,
    `got ${JSON.stringify(result.parsed.password)}`);
  if (c.hasHost && !c.template.includes("notaport")) {
    check(group, `${c.url} [host is dbhost]`, result.parsed.host === "dbhost", `got ${JSON.stringify(result.parsed.host)}`);
  }
}

const parseDb = (url: string) => {
  const d = new DatabaseUrl(url);
  return {
    fields: [d.host, d.username, d.database, d.dsn(), d.toSafeString(), JSON.stringify(d), inspect(d), String(d)].join("\n"),
    password: d.password, host: d.host,
  };
};
const parseGraph = (url: string) => {
  const g = new GraphUrl(url);
  return {
    fields: [g.host, g.username, g.graph, g.getDsn(), JSON.stringify(g.params), g.scheme].join("\n"),
    password: g.password, host: g.host,
  };
};
const parseMqtt = (url: string) => {
  const m = Mqtt.parseUrl(url);
  return { fields: [m.host, m.username, String(m.port)].join("\n"), password: m.password, host: m.host };
};
const parseAmqp = (url: string) => {
  const a = parseAmqpUrl(url);
  return {
    fields: [a.host, a.username, a.vhost, String(a.port)].join("\n"),
    password: a.password ?? null, host: a.host ?? null,
  };
};

console.log(`\n--- parse: DatabaseUrl / GraphUrl / Mqtt.parseUrl / parseAmqpUrl --- (${elapsed()})`);
const PARSERS: [string, string[], typeof parseDb][] = [
  ["DatabaseUrl", DB_SCHEMES, parseDb],
  ["GraphUrl", GRAPH_SCHEMES, parseGraph],
  ["Mqtt.parseUrl", MQTT_SCHEMES, parseMqtt],
  ["parseAmqpUrl", AMQP_SCHEMES, parseAmqp],
];
for (const [label, schemes, parse] of PARSERS) {
  for (const scheme of schemes) {
    const group = `parse ${label} ${scheme}`;
    for (const c of casesFor(scheme)) {
      if (c.known) { knownLimitSkips++; continue; }
      await parseCase(group, c, parse);
    }
    flushGroup(group);
  }
}

// ── 3. must_still_parse ────────────────────────────────────────────────────
console.log(`\n--- must_still_parse: valid URLs (and an unencoded / in a password) still parse --- (${elapsed()})`);
{
  const group = "must-parse";
  for (const m of CASES.must_still_parse) {
    try {
      const d = new DatabaseUrl(m.url);
      check(group, `DatabaseUrl ${m.url}`,
        d.host === m.host && d.username === m.user && d.password === m.password && d.database === m.database
          && (m.port === undefined || d.port === m.port),
        JSON.stringify({ host: d.host, port: d.port, user: d.username, db: d.database, pwOk: d.password === m.password }));
    } catch (err) {
      check(group, `DatabaseUrl ${m.url}`, false, `threw: ${(err as Error).message}`);
    }
    // The same userinfo rule in every parser.
    const swap = (scheme: string) => m.url.replace(/^postgres:/, `${scheme}:`);
    try {
      const g = new GraphUrl(swap("neo4j"));
      check(group, `GraphUrl ${swap("neo4j")}`,
        g.host === m.host && g.username === m.user && g.password === m.password && g.graph === m.database
          && (m.port === undefined || g.port === m.port));
    } catch (err) { check(group, `GraphUrl ${swap("neo4j")}`, false, `threw: ${(err as Error).message}`); }
    try {
      const q = Mqtt.parseUrl(swap("mqtt"));
      check(group, `Mqtt.parseUrl ${swap("mqtt")}`,
        q.host === m.host && q.username === m.user && q.password === m.password && (m.port === undefined || q.port === m.port));
    } catch (err) { check(group, `Mqtt.parseUrl ${swap("mqtt")}`, false, `threw: ${(err as Error).message}`); }
    try {
      const a = parseAmqpUrl(swap("amqp"));
      // AMQP passes userinfo through undecoded (unchanged behaviour), so compare the raw form.
      const rawPw = m.url.slice(m.url.indexOf(":", 11) + 1, m.url.lastIndexOf("@"));
      check(group, `parseAmqpUrl ${swap("amqp")}`,
        a.host === m.host && a.username === m.user && a.password === rawPw && a.vhost === m.database
          && (m.port === undefined || a.port === m.port));
    } catch (err) { check(group, `parseAmqpUrl ${swap("amqp")}`, false, `threw: ${(err as Error).message}`); }
  }
  flushGroup(group);
}

// ── 3b. the rest of the rule ───────────────────────────────────────────────
console.log(`\n--- rule: refusals the shared cases do not reach --- (${elapsed()})`);
{
  const group = "rule";
  const refusedClean = (label: string, fn: () => unknown, secret: string) => {
    try {
      fn();
      check(group, `${label} is refused`, false, "accepted");
    } catch (err) {
      const surfaces = errorSurfaces(err);
      check(group, `${label} is refused without echoing it`, !surfaces.includes(secret), surfaces);
    }
  };
  // Behaviour change: an unencoded @ after the authority (here in the query)
  // makes "which @ ends userinfo" a guess, so it is refused - encode it as %40.
  refusedClean("DatabaseUrl with an @ in the query",
    () => new DatabaseUrl("postgres://u:Zz9pw@dbhost/appdb?contact=a@b"), "Zz9pw");
  refusedClean("GraphUrl with an @ in the query",
    () => new GraphUrl("neo4j://u:Zz9pw@dbhost/g?contact=a@b"), "Zz9pw");
  refusedClean("Mqtt.parseUrl with an @ in the path",
    () => Mqtt.parseUrl("mqtt://u:Zz9pw@dbhost/x@y"), "Zz9pw");
  refusedClean("parseAmqpUrl with an @ in the vhost",
    () => parseAmqpUrl("amqp://u:Zz9pw@dbhost/v@h"), "Zz9pw");
  // Only scheme:// opens an authority for a PARSER, even where a split would
  // happen to come out right.
  for (const shape of ["postgres:/u:Zz9pw@dbhost/appdb", "postgres//u:Zz9pw@dbhost/appdb", "u:Zz9pw@dbhost/appdb"]) {
    refusedClean(`DatabaseUrl ${shape.replace("Zz9pw", "<pw>")}`, () => new DatabaseUrl(shape), "Zz9pw");
    const graphShape = shape.replace("postgres", "neo4j");
    refusedClean(`GraphUrl ${graphShape.replace("Zz9pw", "<pw>")}`, () => new GraphUrl(graphShape), "Zz9pw");
  }
  // Still accepted: an encoded @ in the query, and MQTT/AMQP's bare host[:port].
  let ok = false;
  try { ok = new DatabaseUrl("postgres://u:pw@dbhost/appdb?contact=a%40b").host === "dbhost"; } catch { ok = false; }
  check(group, "an encoded %40 in the query still parses", ok);
  try { ok = Mqtt.parseUrl("broker:1884").host === "broker" && Mqtt.parseUrl("broker:1884").port === 1884; } catch { ok = false; }
  check(group, "a bare MQTT host:port still parses", ok);
  try { ok = parseAmqpUrl("rabbit:5673/v").host === "rabbit" && parseAmqpUrl("rabbit:5673/v").vhost === "v"; } catch { ok = false; }
  check(group, "a bare AMQP host:port/vhost still parses", ok);
  // The documented limit, pinned so a change in it is noticed: a host-less URL
  // whose password is all digits IS a URL with a port.
  check(group, "known limit: postgres://u:123/x keeps its digits",
    redactCredentials("postgres://u:123/x") === "postgres://u:123/x", redactCredentials("postgres://u:123/x"));
  flushGroup(group);
}

// ── 4. connect ─────────────────────────────────────────────────────────────

/**
 * Run one connect attempt per case, for EVERY scheme of a family, all in
 * parallel inside one capture window.
 */
async function connectSweep(
  family: string,
  schemes: string[],
  attempt: (url: string) => Promise<void>,
): Promise<void> {
  const work = schemes.flatMap((scheme) => casesFor(scheme).filter((c) => !c.known).map((c) => ({ scheme, c })));
  const { value: results, out } = await captured(() =>
    Promise.all(work.map(async ({ scheme, c }) => {
      const url = toLoopback(c.url, closedPort);
      try { await attempt(url); return { scheme, url, err: null as unknown }; } catch (err) { return { scheme, url, err }; }
    })),
  );
  check(`connect ${family}`, `captured stdout/stderr of ${work.length} connect attempts`, leakIn(out) === null, out);
  flushGroup(`connect ${family}`);
  for (const scheme of schemes) {
    const group = `connect ${family} ${scheme}`;
    for (const r of results.filter((x) => x.scheme === scheme)) {
      if (r.err === null) {
        // A closed port never answers, so reaching here means nothing was attempted.
        check(group, `${r.url} [fails]`, false, "the connect did not fail against a closed port");
        continue;
      }
      const surfaces = errorSurfaces(r.err);
      check(group, `${r.url} [error is clean]`, leakIn(surfaces) === null, surfaces);
    }
    flushGroup(group);
  }
}

console.log(`\n--- connect: initDatabase against a closed 127.0.0.1 port --- (${elapsed()})`);
await connectSweep("initDatabase", DB_SCHEMES, async (url) => {
  const db = await initDatabase({ url });
  try { await db.fetchOne("select 1"); } finally { try { db.close(); } catch { /* closed */ } }
});

console.log(`\n--- connect: GraphDatabase + query against a closed 127.0.0.1 port --- (${elapsed()})`);
await connectSweep("GraphDatabase", GRAPH_SCHEMES, async (url) => {
  const g = await GraphDatabase.create(url);
  try { await g.query("RETURN 1"); } finally { try { await g.close(); } catch { /* closed */ } }
});

console.log(`\n--- connect: Mqtt.connect against a closed 127.0.0.1 port --- (${elapsed()})`);
await connectSweep("Mqtt", MQTT_SCHEMES, async (url) => {
  const m = new Mqtt({ url, timeout: 2 });
  try { await m.connect(); } finally { try { await (m as any).disconnect?.(); } catch { /* closed */ } }
});

console.log(`\n--- connect: Mongo DocStore against a closed 127.0.0.1 port --- (${elapsed()})`);
{
  const cases = ["mongodb", "mongodb+srv"].flatMap((scheme) => casesFor(scheme).filter((c) => !c.known));
  // The DocStore passes no driver options, so the 30s server-selection default
  // is shortened in the URL itself - only on the shapes that HAVE a host.
  const { value: results, out } = await captured(() =>
    Promise.all(cases.map(async (c) => {
      let url = toLoopback(c.url, closedPort);
      // `?` vs `&` follows the TEMPLATE: a password may itself hold a `?`.
      if (c.hasHost) url += (c.template.includes("?") ? "&" : "?") + "serverSelectionTimeoutMS=1000";
      process.env.TINA4_MONGO_URI = url;
      try {
        // getCollection reads the env synchronously before its first await.
        const pending = getCollection("ghsa_probe");
        await pending;
        return { url, err: null as unknown };
      } catch (err) { return { url, err }; }
    })),
  );
  delete process.env.TINA4_MONGO_URI;
  try { await closeDocStore(); } catch { /* nothing open */ }
  const group = "connect DocStore mongodb/mongodb+srv";
  check(group, `captured output of ${cases.length} attempts`, leakIn(out) === null, out);
  for (const r of results) {
    if (r.err === null) { check(group, `${r.url} [fails]`, false, "connected to a closed port?"); continue; }
    const surfaces = errorSurfaces(r.err);
    check(group, `${r.url} [error is clean]`, leakIn(surfaces) === null, surfaces);
  }
  flushGroup(group);
}

console.log(`\n--- connect: RabbitMQBackend.push (cases its parser accepts as 127.0.0.1) --- (${elapsed()})`);
// The backend spawns a child per operation and swallows its stderr, so it is
// driven only for the URLs that parse to the loopback host - a mis-split host
// is already caught at the parse surface, and would cost a 10s child timeout
// on a DNS lookup here.
for (const scheme of AMQP_SCHEMES) {
  const group = `connect RabbitMQ ${scheme}`;
  for (const c of casesFor(scheme).filter((x) => !x.known)) {
    const url = toLoopback(c.url, closedPort);
    let host: string | undefined;
    try { host = parseAmqpUrl(url).host; } catch { continue; }
    if (host !== "127.0.0.1") continue;
    process.env.TINA4_QUEUE_URL = url;
    const { value: err, out } = await captured(async () => {
      try { new RabbitMQBackend().push("ghsa_probe", { x: 1 }); return null; } catch (e) { return e; }
    });
    check(group, `${url} [output]`, leakIn(out) === null, out);
    if (err === null) check(group, `${url} [fails]`, false, "published to a closed port?");
    else check(group, `${url} [error is clean]`, leakIn(errorSurfaces(err)) === null, errorSurfaces(err));
  }
  delete process.env.TINA4_QUEUE_URL;
  flushGroup(group);
}

console.log(`\n--- connect: RedisBackplane against a closed 127.0.0.1 port --- (${elapsed()})`);
{
  // The constructor either refuses the URL, or starts a background connect
  // whose failure is LOGGED (observeConnectFailure) and rejects `ready`.
  const { RedisBackplane } = await import("../packages/core/src/websocketBackplane.ts");
  const cases = casesFor("redis").filter((c) => !c.known);
  const { value: results, out } = await captured(() =>
    Promise.all(cases.map(async (c) => {
      const url = toLoopback(c.url, closedPort);
      let backplane: any;
      try { backplane = new RedisBackplane(url); } catch (err) { return { url, err }; }
      try {
        await backplane.ready;
        return { url, err: null as unknown };
      } catch (err) {
        return { url, err };
      } finally {
        // close() waits on a connection that never opened; drop the clients instead.
        for (const client of [backplane.publisher, backplane.subscriber]) {
          try { await client?.disconnect(); } catch { /* never connected */ }
        }
      }
    })),
  );
  const group = "connect RedisBackplane redis";
  check(group, `captured output of ${cases.length} attempts`, leakIn(out) === null, out);
  for (const r of results) {
    if (r.err === null) { check(group, `${r.url} [fails]`, false, "connected to a closed port?"); continue; }
    const surfaces = errorSurfaces(r.err);
    check(group, `${r.url} [error is clean]`, leakIn(surfaces) === null, surfaces);
  }
  flushGroup(group);
}

// ── 5b. boot + dev admin ───────────────────────────────────────────────────
console.log(`\n--- boot: startServer() log and GET /__dev/api/connections --- (${elapsed()})`);
{
  const group = "boot postgres";
  check(group, `boot log driven with ${BOOT_PASSWORDS.length} passwords`, BOOT_PASSWORDS.length === 3, BOOT_PASSWORDS.join(","));
  for (const r of await bootResults) {
    check(group, `${r.url} [boot log]`, leakIn(r.log) === null,
      r.log.split("\n").filter((l) => leakIn(l)).join(" | "));
    check(group, `${r.url} [/__dev/api/connections]`,
      r.connections.startsWith("200") && leakIn(r.connections) === null, r.connections);
    if (r.roundTrip) {
      check(group, `${r.url} [saving the redacted url keeps the real one in .env]`,
        r.savedEnv.includes(`TINA4_DATABASE_URL=${r.url}`) && !r.savedEnv.includes("***"), r.savedEnv);
      check(group, `dev admin GET swept every case (${r.sweep.length} of ${allPostgresUrls.length})`,
        r.sweep.length === allPostgresUrls.length);
      for (const one of r.sweep) {
        check(group, `${one.url} [/__dev/api/connections]`, one.body.startsWith("200") && leakIn(one.body) === null, one.body);
      }
    }
  }
  for (const root of bootRoots) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
  flushGroup(group);
}

// ── the exclusion is exactly the documented one ────────────────────────────
console.log(`\n--- known limits --- (${elapsed()})`);
{
  // redact (25 schemes) + parse (23 schemes); connect/boot filter it out of their own lists.
  const expected = [...DB_SCHEMES, ...GRAPH_SCHEMES, ...MQTT_SCHEMES, ...AMQP_SCHEMES, ...REDACT_ONLY_SCHEMES].length
    + [...DB_SCHEMES, ...GRAPH_SCHEMES, ...MQTT_SCHEMES, ...AMQP_SCHEMES].length;
  check("known-limit", `only "${KNOWN_LIMIT_TEMPLATE}" x "${KNOWN_LIMIT_PASSWORD}" is skipped`,
    knownLimitSkips === expected, `skipped ${knownLimitSkips}, expected ${expected}`);
  flushGroup("known-limit");
}

console.log(`\n  failures by surface: ${JSON.stringify(Object.fromEntries(failsBySurface))}`);
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
