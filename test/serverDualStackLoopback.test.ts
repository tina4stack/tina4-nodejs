/**
 * The built-in dev server must be reachable on BOTH loopback families.
 *
 * THE BUG (measured on Windows, not theorised): `localhost` resolves to `::1`
 * (IPv6) FIRST on Windows, so a server bound only to `127.0.0.1` — or to
 * `0.0.0.0`, the IPv4 wildcard, which does NOT cover IPv6 — refused the browser
 * with ERR_CONNECTION_REFUSED even though it was serving, because nothing
 * listened on `::1`. Binding the sibling loopback family closes that gap.
 *
 * Port of tina4-php PR #206 (ServerDualStackLoopbackTest) to Node.
 *
 * NO MOCKS: `loopbackBindHosts` is a pure function tested over its inputs, and
 * the dual-stack case starts the REAL `startServer()` bound to 127.0.0.1 and a
 * REAL http client connects on each family. No subprocess is spawned, so it
 * runs cross-OS — including the Windows where the bug lives, and Linux CI.
 *
 * The IPv6 assertion is a GATE: with the sibling listener STASHED it goes red
 * (proven by the stashed-baseline run), and green with the fix applied.
 *
 * Run with: npx tsx test/serverDualStackLoopback.test.ts
 */
import net from "node:net";
import http from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lean boot: no banner, no browser, no AI port, no rate-limit interference.
process.env.TINA4_SUPPRESS = "true";
process.env.TINA4_NO_BROWSER = "true";
process.env.TINA4_NO_AI_PORT = "true";
process.env.TINA4_RATE_LIMIT = "100000";

const { startServer, loopbackBindHosts } = await import("../packages/core/src/index.ts");

let pass = 0;
let fail = 0;
let skip = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const eq = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A free ephemeral port on 127.0.0.1 (bind 0, read back, release). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** True when this host can bind IPv6 loopback (::1) at all. Real bind, no guess. */
function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

/** Real HTTP GET; resolves the status code, or -1 on any transport failure. */
function httpGet(host: string, port: number, path: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method: "GET", timeout: 5000 }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", () => resolve(-1));
    req.on("timeout", () => { req.destroy(); resolve(-1); });
    req.end();
  });
}

function project(name: string): string {
  const dir = join(tmpdir(), `tina4-dualstack-${process.pid}-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src", "routes"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  return dir;
}

console.log("=== Dual-stack loopback (localhost reachable on IPv4 AND IPv6) ===\n");

// ── UNIT: loopbackBindHosts names the sibling family, leaves LAN alone ───────
console.log("--- loopbackBindHosts mapping ---");
assert("127.0.0.1 needs the IPv6 sibling",
  eq(loopbackBindHosts("127.0.0.1"), ["::1"]),
  JSON.stringify(loopbackBindHosts("127.0.0.1")));
assert("the IPv4 wildcard 0.0.0.0 still misses IPv6 loopback",
  eq(loopbackBindHosts("0.0.0.0"), ["::1"]),
  JSON.stringify(loopbackBindHosts("0.0.0.0")));
assert("::1 needs the IPv4 sibling",
  eq(loopbackBindHosts("::1"), ["127.0.0.1"]),
  JSON.stringify(loopbackBindHosts("::1")));
assert("the IPv6 wildcard :: needs the IPv4 sibling",
  eq(loopbackBindHosts("::"), ["127.0.0.1"]),
  JSON.stringify(loopbackBindHosts("::")));
assert("localhost resolves per-OS, so bind both explicitly",
  eq(loopbackBindHosts("localhost"), ["127.0.0.1", "::1"]),
  JSON.stringify(loopbackBindHosts("localhost")));
assert("an explicit LAN address is bound exactly as asked (empty sibling list)",
  eq(loopbackBindHosts("192.168.1.10"), []),
  JSON.stringify(loopbackBindHosts("192.168.1.10")));
// Normalisation: brackets stripped, whitespace trimmed, case-folded.
assert("a bracketed [::1] normalises like ::1",
  eq(loopbackBindHosts("[::1]"), ["127.0.0.1"]),
  JSON.stringify(loopbackBindHosts("[::1]")));
assert("surrounding whitespace and case are normalised",
  eq(loopbackBindHosts("  LOCALHOST "), ["127.0.0.1", "::1"]),
  JSON.stringify(loopbackBindHosts("  LOCALHOST ")));

// ── REAL: a server bound to IPv4 loopback also answers on IPv6 loopback ───────
console.log("\n--- real server bound to 127.0.0.1 answers on both families ---");
{
  const dir = project("dualstack");
  const requested = await freePort();
  const srv = await startServer({
    port: requested,
    host: "127.0.0.1",
    routesDir: join(dir, "src/routes"),
    modelsDir: join(dir, "src/models"),
    staticDir: join(dir, "public"),
  } as any);
  const port = srv.port;

  try {
    // Primary IPv4 loopback MUST serve — the baseline behaviour.
    const v4 = await httpGet("127.0.0.1", port, "/health");
    assert("the primary IPv4 loopback listener serves a real request",
      v4 === 200, `GET http://127.0.0.1:${port}/health -> ${v4}`);

    if (await ipv6LoopbackAvailable()) {
      // IPv6 loopback MUST ALSO serve after the dual-stack fix. This is the gate.
      const v6 = await httpGet("::1", port, "/health");
      assert("IPv6 loopback ::1 ALSO serves on the same port (the dual-stack fix)",
        v6 === 200, `GET http://[::1]:${port}/health -> ${v6}`);

      // Negative control: the probe is not always-green. A DIFFERENT, unbound
      // IPv6 port must refuse — proves the success above is a real bind.
      const freeV6 = await freePort();
      const refused = await httpGet("::1", freeV6, "/health");
      assert("an unbound ::1 port refuses (the connect probe can fail)",
        refused === -1, `GET http://[::1]:${freeV6}/health -> ${refused}`);
    } else {
      console.log("  \x1b[33mSKIP\x1b[0m IPv6 loopback (::1) is unavailable on this host [needs:ipv6-loopback]");
      skip++;
    }
  } finally {
    srv.close();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${"=".repeat(52)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m, \x1b[33m${skip} skipped\x1b[0m`);
console.log(`${"=".repeat(52)}\n`);

process.exit(fail > 0 ? 1 : 0);
