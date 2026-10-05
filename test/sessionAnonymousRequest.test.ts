/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A request that writes nothing to the session stores no session and sets no
 * session cookie.
 *
 * Every request used to store a session and (nearly every one) set a cookie:
 * static files, 404s and /health included, so session storage grew with
 * anonymous traffic. Session.start() wrote each freshly minted session to the
 * store before the route ran, and sessionAutoStart set a cookie for any id the
 * client had not sent - also for a cookie the store does not know, whose
 * replacement was never stored either, so the next request was handed another.
 *
 * A REAL startServer() over real sockets: every case counts the session files
 * and reads every Set-Cookie line off the wire.
 *
 * Run with: npx tsx test/sessionAnonymousRequest.test.ts
 */
import { startServer, Session } from "../packages/core/src/index.ts";
import http from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freePort } from "./freePort.ts";

const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-session-anonymous-test-"));
const PORT = await freePort();
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

function get(path: string, cookie?: string): Promise<{ status: number; body: string; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request({ hostname: "127.0.0.1", port: PORT, path, method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        const raw = res.headers["set-cookie"];
        resolve({ status: res.statusCode ?? 0, body: data, setCookies: Array.isArray(raw) ? raw : raw ? [raw] : [] });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

for (const [name, body] of Object.entries({
  plain: `return res.text("plain");`,
  read: `return res.text("user=" + (req.session.get("user") ?? "-"));`,
  write: `req.session.set("user", "alice"); return res.text("wrote");`,
  // Calls that mark a session changed without leaving anything in it. A record
  // with no data is not a session, so none may store one.
  clear: `req.session.clear(); return res.text("cleared");`,
  "delete-missing": `req.session.delete("never-set"); return res.text("deleted nothing");`,
  "regenerate-empty": `req.session.regenerate(); return res.text("regenerated");`,
  "read-flash": `return res.text("flash=" + (req.session.getFlash("error") ?? "-"));`,
})) {
  mkdirSync(join(TEST_DIR, `src/routes/${name}`), { recursive: true });
  writeFileSync(join(TEST_DIR, `src/routes/${name}/get.ts`), `
export const noAuth = true;
export default async function (req: any, res: any) {
  ${body}
}
`);
}
mkdirSync(join(TEST_DIR, "public"), { recursive: true });
writeFileSync(join(TEST_DIR, "public/hello.txt"), "static file");
writeFileSync(join(TEST_DIR, "package.json"), '{"type":"module"}');

const sessDir = mkdtempSync(join(tmpdir(), "tina4-session-anonymous-store-"));
const files = () => readdirSync(sessDir).length;
process.env.TINA4_SESSION_BACKEND = "file";
process.env.TINA4_SESSION_PATH = sessDir;
process.env.TINA4_RATE_LIMIT = "100000";

console.log("=== Session - a request that writes nothing stores no session and sets no cookie ===\n");

const server = await startServer({
  port: PORT,
  routesDir: join(TEST_DIR, "src/routes"),
  modelsDir: join(TEST_DIR, "src/models"),
  staticDir: join(TEST_DIR, "public"),
});

try {
  for (const [what, path] of [
    ["a static file", "/hello.txt"], ["a 404", "/missing"], ["/health", "/health"],
    ["a route that never touches the session", "/plain"], ["a route that reads the session", "/read"],
    ["a route that clears the session", "/clear"], ["a route that deletes a key it never set", "/delete-missing"],
    ["a route that regenerates an empty session", "/regenerate-empty"],
    ["a route that reads a flash message", "/read-flash"],
  ]) {
    const before = files();
    const cookies: string[] = [];
    for (let i = 0; i < 3; i++) cookies.push(...(await get(path)).setCookies);
    assert(`${what} sets no cookie`, cookies.length === 0, `got ${JSON.stringify(cookies)}`);
    assert(`${what} stores no session`, files() === before, `session files ${before} -> ${files()}`);
  }

  {
    const before = files();
    const reply = await get("/read", `tina4_session=${randomBytes(16).toString("hex")}`);
    assert("a cookie the store never issued reads an empty session", reply.body === "user=-", reply.body);
    assert("a cookie the store never issued gets no replacement cookie", reply.setCookies.length === 0,
      `got ${JSON.stringify(reply.setCookies)}`);
    assert("a cookie the store never issued stores no session", files() === before);
  }

  for (const [what, path] of [
    ["a route that clears the session", "/clear"], ["a route that deletes a key it never set", "/delete-missing"],
    ["a route that regenerates an empty session", "/regenerate-empty"],
    ["a route that reads a flash message", "/read-flash"],
  ]) {
    // An expired or foreign cookie: the store holds nothing under it either.
    const before = files();
    const cookies: string[] = [];
    for (let i = 0; i < 3; i++) cookies.push(...(await get(path, `tina4_session=${randomBytes(16).toString("hex")}`)).setCookies);
    assert(`${what}, with a cookie the store never issued, sets no cookie`, cookies.length === 0, `got ${JSON.stringify(cookies)}`);
    assert(`${what}, with a cookie the store never issued, stores no session`, files() === before, `session files ${before} -> ${files()}`);
  }

  {
    // Only a session nothing ever stored is skipped for being empty. One the
    // store holds that a request empties is a logout: its record must go, or
    // the next request is logged straight back in.
    const write = await get("/write");
    const pair = (write.setCookies.find((c) => c.startsWith("tina4_session=")) ?? "").split(";")[0];
    assert("a stored session resumes before it is cleared", (await get("/read", pair)).body === "user=alice");
    await get("/clear", pair);
    assert("clearing a stored session still ends it", (await get("/read", pair)).body === "user=-");
  }

  {
    const before = files();
    const write = await get("/write");
    const cookies = write.setCookies.filter((c) => c.startsWith("tina4_session="));
    assert("a write sets exactly one session cookie", cookies.length === 1, `got ${JSON.stringify(write.setCookies)}`);
    assert("a write stores the session", files() === before + 1, `session files ${before} -> ${files()}`);
    if (cookies.length === 1) {
      const read = await get("/read", cookies[0].split(";")[0]);
      assert("a replay of the write's cookie resumes the session", read.body === "user=alice", read.body);
      assert("a resumed session needs no new cookie", read.setCookies.length === 0, JSON.stringify(read.setCookies));
    }
  }

  {
    const before = files();
    const session = new Session();
    session.start();
    assert("a session minted by start() is fresh", session.isFresh() === true);
    session.save();
    assert("saving a fresh session writes nothing", files() === before, `session files ${before} -> ${files()}`);
    session.set("user", "alice");
    assert("a written session is not fresh", session.isFresh() === false);
    session.save();
    assert("its first save after a change writes it", files() === before + 1);
  }

  {
    const before = files();
    const session = new Session();
    session.start();
    session.delete("never-set");
    session.clear();
    assert("a session changed and emptied again is fresh", session.isFresh() === true);
    assert("saving it writes nothing", session.save() === true && files() === before, `session files ${before} -> ${files()}`);
  }
} finally {
  server.close();
  delete process.env.TINA4_SESSION_BACKEND;
  delete process.env.TINA4_SESSION_PATH;
  delete process.env.TINA4_RATE_LIMIT;
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(sessDir, { recursive: true }); } catch { /* ignore */ }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
