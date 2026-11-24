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
 * A FAILURE NEVER PRINTS A SECRET. Every case is named by an id - scheme,
 * template #N, password #N (their positions in the fixture) - and a leak is
 * reported as WHICH fragment (#N in secret_fragments) turned up on WHICH
 * surface (redacted form, a parsed field, error.message, cause[1].stack, the
 * captured output, the boot log, ...). The produced text itself is never
 * logged: a test that prints the value it caught leaking is a leak of its own.
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

/**
 * One assertion. PASS lines are folded per group (thousands of cases); every
 * FAIL prints. `name` and `why` are secret-free BY CONSTRUCTION: case ids,
 * surface labels and fragment numbers - never produced text.
 */
function check(group: string, name: string, ok: boolean, why = ""): void {
  if (ok) {
    pass++;
    groupPass.set(group, (groupPass.get(group) ?? 0) + 1);
    return;
  }
  fail++;
  const surface = group.split(" ")[0];
  failsBySurface.set(surface, (failsBySurface.get(surface) ?? 0) + 1);
  console.log(`  \x1b[31mFAIL\x1b[0m [${group}] ${name}${why ? ` - ${why}` : ""}`);
}

function flushGroup(group: string): void {
  const n = groupPass.get(group) ?? 0;
  if (n > 0) console.log(`  \x1b[32mPASS\x1b[0m [${group}] ${n} case(s)`);
  groupPass.delete(group);
}

/** Which secret fragment `text` carries, by NAME ("fragment #1"), or null. */
function leakIn(text: string): string | null {
  const index = FRAGMENTS.findIndex((f) => text.includes(f));
  return index === -1 ? null : `fragment #${index + 1}`;
}

/** A labelled piece of output, so a leak can be reported by WHERE it was. */
interface Surface { label: string; text: string }

/** The first surface carrying a fragment, as "fragment #N in <label>", or null. */
function leakInSurfaces(surfaces: Surface[]): string | null {
  for (const s of surfaces) {
    const leak = leakIn(s.text);
    if (leak !== null) return `${leak} in ${s.label}`;
  }
  return null;
}

/** Every surface an error offers: message, stack, inspect (own props) and the cause chain. */
function errorSurfaces(err: unknown, prefix = "error"): Surface[] {
  const parts: Surface[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let depth = 0;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const at = depth === 0 ? prefix : `${prefix}.cause[${depth}]`;
    if (cur instanceof Error) {
      parts.push({ label: `${at}.message`, text: String(cur.message) }, { label: `${at}.stack`, text: String(cur.stack ?? "") });
      if (cur instanceof AggregateError) cur.errors.forEach((e, i) => parts.push(...errorSurfaces(e, `${at}.errors[${i}]`)));
    } else {
      parts.push({ label: at, text: String(cur) });
    }
    try { parts.push({ label: `inspect(${at})`, text: inspect(cur, { depth: 6, showHidden: false }) }); } catch { /* unrenderable */ }
    cur = (cur as { cause?: unknown })?.cause;
    depth++;
  }
  return parts;
}

const errorLeak = (err: unknown): string | null => leakInSurfaces(errorSurfaces(err));

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

interface Case { id: string; scheme: string; template: string; pw: string; url: string; hasHost: boolean; known: boolean }

function casesFor(scheme: string): Case[] {
  const out: Case[] = [];
  for (const [t, template] of CASES.templates.entries()) {
    for (const [p, pw] of CASES.passwords.entries()) {
      out.push({
        // What a failure prints: positions in the fixture, never the URL.
        id: `${scheme} template #${t + 1} password #${p + 1}`,
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
const BOOT_SHAPES = ["Pq1/Rs2", "Pq1 Rs2", "12?Pq1Rs2"].filter((pw) => CASES.passwords.includes(pw));

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


const bootCases = casesFor("postgres").filter((c) => !c.known && BOOT_SHAPES.includes(c.pw));
const allPostgresCases = casesFor("postgres").filter((c) => !c.known);
const allPostgresUrls = allPostgresCases.map((c) => toLoopback(c.url, closedPort));
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
    check(group, c.id, leak === null, `the redacted form carries ${leak}`);
    const keeps = out.includes(scheme) && out.includes("u") && (!c.hasHost || out.includes("dbhost"));
    check(group, `${c.id} keeps scheme/user/host`, keeps, "the scheme, user or host is missing from the redacted form");
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
  parse: (url: string) => { fields: Surface[]; password: string | null; host: string | null },
): Promise<void> {
  const { value: result, out } = await captured(async () => {
    try { return { ok: true as const, parsed: parse(c.url) }; } catch (err) { return { ok: false as const, err }; }
  });
  check(group, `${c.id} [output]`, leakIn(out) === null, `the captured output carries ${leakIn(out)}`);
  if (!result.ok) {
    const leak = errorLeak(result.err);
    check(group, `${c.id} [refusal is clean]`, leak === null, leak ?? "");
    return;
  }
  const fieldLeak = leakInSurfaces(result.parsed.fields);
  check(group, `${c.id} [parsed fields are clean]`, fieldLeak === null, fieldLeak ?? "");
  check(group, `${c.id} [password split correctly]`, result.parsed.password === c.pw,
    "the parsed password is not the one written");
  if (c.hasHost && !c.template.includes("notaport")) {
    check(group, `${c.id} [host is dbhost]`, result.parsed.host === "dbhost", "the parsed host is not dbhost");
  }
}

/** Named fields, so a leak says which one. */
const fields = (named: Record<string, unknown>): Surface[] =>
  Object.entries(named).map(([label, value]) => ({ label: `field ${label}`, text: String(value) }));

const parseDb = (url: string) => {
  const d = new DatabaseUrl(url);
  return {
    fields: fields({
      host: d.host, username: d.username, database: d.database, "dsn()": d.dsn(), "toSafeString()": d.toSafeString(),
      "JSON.stringify": JSON.stringify(d), inspect: inspect(d), "String()": String(d),
    }),
    password: d.password, host: d.host,
  };
};
const parseGraph = (url: string) => {
  const g = new GraphUrl(url);
  return {
    fields: fields({ host: g.host, username: g.username, graph: g.graph, "getDsn()": g.getDsn(), params: JSON.stringify(g.params), scheme: g.scheme }),
    password: g.password, host: g.host,
  };
};
const parseMqtt = (url: string) => {
  const m = Mqtt.parseUrl(url);
  return { fields: fields({ host: m.host, username: m.username, port: m.port }), password: m.password, host: m.host };
};
const parseAmqp = (url: string) => {
  const a = parseAmqpUrl(url);
  return {
    fields: fields({ host: a.host, username: a.username, vhost: a.vhost, port: a.port }),
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
  /** Which expected fields differ - by NAME, never by value. */
  const mismatches = (got: Record<string, unknown>, want: Record<string, unknown>): string =>
    Object.keys(want).filter((k) => want[k] !== undefined && got[k] !== want[k]).join(", ");
  const threw = (err: unknown): string => `threw ${(err as Error)?.name ?? typeof err}`;
  for (const [k, m] of CASES.must_still_parse.entries()) {
    const id = `must_still_parse #${k + 1}`;
    const want = { host: m.host, port: m.port, user: m.user, password: m.password, database: m.database };
    try {
      const d = new DatabaseUrl(m.url);
      const differ = mismatches({ host: d.host, port: d.port, user: d.username, password: d.password, database: d.database }, want);
      check(group, `DatabaseUrl ${id}`, differ === "", `differs in: ${differ}`);
    } catch (err) {
      check(group, `DatabaseUrl ${id}`, false, threw(err));
    }
    // The same userinfo rule in every parser.
    const swap = (scheme: string) => m.url.replace(/^postgres:/, `${scheme}:`);
    try {
      const g = new GraphUrl(swap("neo4j"));
      const differ = mismatches({ host: g.host, port: g.port, user: g.username, password: g.password, database: g.graph }, want);
      check(group, `GraphUrl ${id}`, differ === "", `differs in: ${differ}`);
    } catch (err) { check(group, `GraphUrl ${id}`, false, threw(err)); }
    try {
      const q = Mqtt.parseUrl(swap("mqtt"));
      const differ = mismatches({ host: q.host, port: q.port, user: q.username, password: q.password }, { ...want, database: undefined });
      check(group, `Mqtt.parseUrl ${id}`, differ === "", `differs in: ${differ}`);
    } catch (err) { check(group, `Mqtt.parseUrl ${id}`, false, threw(err)); }
    try {
      const a = parseAmqpUrl(swap("amqp"));
      // AMQP passes userinfo through undecoded (unchanged behaviour), so compare the raw form.
      const rawPw = m.url.slice(m.url.indexOf(":", 11) + 1, m.url.lastIndexOf("@"));
      const differ = mismatches({ host: a.host, port: a.port, user: a.username, password: a.password, database: a.vhost }, { ...want, password: rawPw });
      check(group, `parseAmqpUrl ${id}`, differ === "", `differs in: ${differ}`);
    } catch (err) { check(group, `parseAmqpUrl ${id}`, false, threw(err)); }
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
      const echoed = errorSurfaces(err).find((s) => s.text.includes(secret));
      check(group, `${label} is refused without echoing it`, echoed === undefined, `the probe password appears in ${echoed?.label}`);
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
  // The shared splitter itself (packages/core/src/connectionUrl.ts), which every
  // parser above delegates to. Loaded dynamically so this file still REPORTS on
  // a tree that predates it, instead of dying at import.
  const splitter = await import("../packages/core/src/connectionUrl.ts").catch(() => null);
  check(group, "the shared splitter module exists", splitter !== null);
  if (splitter !== null) {
    const parts = splitter.splitConnectionUrl("postgres://u:Zz9/pw@dbhost:5432/appdb", { label: "probe" });
    check(group, "splitConnectionUrl: userinfo ends at the last @, the password keeps its /",
      parts.username === "u" && parts.password === "Zz9/pw" && parts.host === "dbhost" && parts.port === 5432
        && parts.tail === "/appdb");
    check(group, "canonicalConnectionUrl re-encodes the credentials for a driver",
      splitter.canonicalConnectionUrl(parts) === "postgres://u:Zz9%2Fpw@dbhost:5432/appdb");
  }
  try { ok = Mqtt.parseUrl("broker:1884").host === "broker" && Mqtt.parseUrl("broker:1884").port === 1884; } catch { ok = false; }
  check(group, "a bare MQTT host:port still parses", ok);
  try { ok = parseAmqpUrl("rabbit:5673/v").host === "rabbit" && parseAmqpUrl("rabbit:5673/v").vhost === "v"; } catch { ok = false; }
  check(group, "a bare AMQP host:port/vhost still parses", ok);
  // The documented limit, pinned so a change in it is noticed: a host-less URL
  // whose password is all digits IS a URL with a port.
  check(group, "known limit: postgres://u:123/x keeps its digits",
    redactCredentials("postgres://u:123/x") === "postgres://u:123/x", "its redaction changed - update the documented limit");
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
      try { await attempt(url); return { scheme, c, err: null as unknown }; } catch (err) { return { scheme, c, err }; }
    })),
  );
  check(`connect ${family}`, `captured stdout/stderr of ${work.length} connect attempts`, leakIn(out) === null,
    `the captured output carries ${leakIn(out)}`);
  flushGroup(`connect ${family}`);
  for (const scheme of schemes) {
    const group = `connect ${family} ${scheme}`;
    for (const r of results.filter((x) => x.scheme === scheme)) {
      if (r.err === null) {
        // A closed port never answers, so reaching here means nothing was attempted.
        check(group, `${r.c.id} [fails]`, false, "the connect did not fail against a closed port");
        continue;
      }
      const leak = errorLeak(r.err);
      check(group, `${r.c.id} [error is clean]`, leak === null, leak ?? "");
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
        return { c, err: null as unknown };
      } catch (err) { return { c, err }; }
    })),
  );
  delete process.env.TINA4_MONGO_URI;
  try { await closeDocStore(); } catch { /* nothing open */ }
  const group = "connect DocStore mongodb/mongodb+srv";
  check(group, `captured output of ${cases.length} attempts`, leakIn(out) === null, `the captured output carries ${leakIn(out)}`);
  for (const r of results) {
    if (r.err === null) { check(group, `${r.c.id} [fails]`, false, "connected to a closed port?"); continue; }
    const leak = errorLeak(r.err);
    check(group, `${r.c.id} [error is clean]`, leak === null, leak ?? "");
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
    check(group, `${c.id} [output]`, leakIn(out) === null, `the captured output carries ${leakIn(out)}`);
    if (err === null) check(group, `${c.id} [fails]`, false, "published to a closed port?");
    else check(group, `${c.id} [error is clean]`, errorLeak(err) === null, errorLeak(err) ?? "");
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
      try { backplane = new RedisBackplane(url); } catch (err) { return { c, err }; }
      try {
        await backplane.ready;
        return { c, err: null as unknown };
      } catch (err) {
        return { c, err };
      } finally {
        // close() waits on a connection that never opened; drop the clients instead.
        for (const client of [backplane.publisher, backplane.subscriber]) {
          try { await client?.disconnect(); } catch { /* never connected */ }
        }
      }
    })),
  );
  const group = "connect RedisBackplane redis";
  check(group, `captured output of ${cases.length} attempts`, leakIn(out) === null, `the captured output carries ${leakIn(out)}`);
  for (const r of results) {
    if (r.err === null) { check(group, `${r.c.id} [fails]`, false, "connected to a closed port?"); continue; }
    const leak = errorLeak(r.err);
    check(group, `${r.c.id} [error is clean]`, leak === null, leak ?? "");
  }
  flushGroup(group);
}

// ── 5b. boot + dev admin ───────────────────────────────────────────────────
console.log(`\n--- boot: startServer() log and GET /__dev/api/connections --- (${elapsed()})`);
{
  const group = "boot postgres";
  check(group, "boot log driven with all three boot shapes", BOOT_SHAPES.length === 3,
    "the fixture no longer holds all three boot passwords");
  /** Status and leak of one GET /connections reply - never its body. */
  const replyProblem = (reply: string): string => {
    const leak = leakIn(reply);
    return reply.startsWith("200") ? `the reply carries ${leak}` : `status ${reply.slice(0, 3)}`;
  };
  for (const r of await bootResults) {
    const lineNo = r.log.split("\n").findIndex((l) => leakIn(l) !== null);
    check(group, `${r.c.id} [boot log]`, lineNo === -1, `boot log line ${lineNo + 1} carries ${leakIn(r.log)}`);
    check(group, `${r.c.id} [/__dev/api/connections]`,
      r.connections.startsWith("200") && leakIn(r.connections) === null, replyProblem(r.connections));
    if (r.roundTrip) {
      check(group, `${r.c.id} [saving the redacted url keeps the real one in .env]`,
        r.savedEnv.includes(`TINA4_DATABASE_URL=${r.url}`) && !r.savedEnv.includes("***"),
        "the .env no longer holds the stored URL");
      check(group, `dev admin GET swept every case (${r.sweep.length} of ${allPostgresUrls.length})`,
        r.sweep.length === allPostgresUrls.length);
      r.sweep.forEach((one, i) => {
        check(group, `${allPostgresCases[i].id} [/__dev/api/connections]`,
          one.body.startsWith("200") && leakIn(one.body) === null, replyProblem(one.body));
      });
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
  check("known-limit", "only the documented host-less unencoded-@ case is skipped",
    knownLimitSkips === expected, `skipped ${knownLimitSkips}, expected ${expected}`);
  flushGroup("known-limit");
}

console.log(`\n  failures by surface: ${JSON.stringify(Object.fromEntries(failsBySurface))}`);
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
