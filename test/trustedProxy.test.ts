/**
 * Feature 11 (rate limiter) - the client key must not be attacker-controlled.
 *
 * ADR-0019. X-Forwarded-For is written by whoever sends it, so reading it
 * unconditionally let any client pick its own rate-limit bucket, and let it
 * pick SOMEONE ELSE'S. Case names match tina4-python/tests/test_trusted_proxy.py,
 * tina4-ruby/spec/trusted_proxy_spec.rb and tina4-php/tests/TrustedProxyTest.php.
 *
 * The rate-limit cases drive REAL HTTP through a REAL node:http server with the
 * REAL rateLimiter() middleware. No doubles.
 *
 * Run with: npx tsx test/trustedProxy.test.ts
 */
import http from "node:http";
import {
  isTrustedProxy,
  trustedProxyNetworks,
  resolveClientIp,
  resetTrustedProxyCache,
  rateLimiter,
} from "../packages/core/src/index.ts";
import { createRequest } from "../packages/core/src/request.ts";
import { createResponse } from "../packages/core/src/response.ts";
import { freePort } from "./freePort.ts";

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

function setTrusted(value: string | undefined): void {
  if (value === undefined) delete process.env.TINA4_TRUSTED_PROXIES;
  else process.env.TINA4_TRUSTED_PROXIES = value;
  resetTrustedProxyCache();
}

/**
 * A real server whose only middleware is the real rate limiter. The socket
 * peer is 127.0.0.1 because we connect over loopback, so "is the peer
 * trusted?" is controlled by listing (or not listing) that address.
 */
const TEST_PEER = "127.0.0.1";

async function withLimitedServer(
  limit: number,
  run: (hit: (forwardedFor: string) => Promise<number>) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const limiter = rateLimiter({ limit, windowSeconds: 60 });

  const server = http.createServer((raw, rawRes) => {
    const req = createRequest(raw);
    const res = createResponse(rawRes);
    limiter(req, res, () => { res({ ok: true }, 200); });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const hit = (forwardedFor: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const r = http.request(
        { host: "127.0.0.1", port, path: "/probe", method: "GET",
          headers: { "X-Forwarded-For": forwardedFor } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      r.on("error", reject);
      r.end();
    });

  try {
    await run(hit);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log("\n  Trusted proxy / rate limit client key\n");

// ---------------------------------------------------------------- rate limit
setTrusted(undefined);
await withLimitedServer(3, async (hit) => {
  // No TINA4_TRUSTED_PROXIES: the header is noise, the peer is the client.
  // A rotating X-Forwarded-For must NOT buy extra requests.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push(await hit(`203.0.113.${i}`));
  assert(
    "rate limit ignores forwarded for from an untrusted peer",
    JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 429, 429, 429]),
    `rotating X-Forwarded-For bypassed the limiter. Got ${JSON.stringify(statuses)}`,
  );
});

setTrusted(TEST_PEER);
await withLimitedServer(3, async (hit) => {
  // The positive twin: once the peer IS a declared proxy, per-client bucketing
  // must still work, or the fix would just break real deployments.
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push(await hit(`203.0.113.${i}`));
  assert(
    "rate limit honours forwarded for from a trusted proxy",
    statuses.every((s) => s === 200),
    `distinct clients must get distinct buckets. Got ${JSON.stringify(statuses)}`,
  );
});

setTrusted(undefined);
assert(
  "rate limit forged forwarded for cannot starve another client",
  !isTrustedProxy("198.51.100.7")
    && resolveClientIp({ "x-forwarded-for": "198.51.100.7" }, TEST_PEER) === TEST_PEER,
  "forged traffic must land in the peer's bucket, never the victim's",
);

// ------------------------------------------------------- trusted proxy match
setTrusted("192.168.1.5");
assert("trusted proxy matches an exact address",
  isTrustedProxy("192.168.1.5") && !isTrustedProxy("192.168.1.6"));

setTrusted("10.0.0.0/8");
assert("trusted proxy matches a cidr range",
  isTrustedProxy("10.4.5.6") && !isTrustedProxy("11.4.5.6"));

setTrusted("::1, fd00::/8");
assert("trusted proxy matches an ipv6 address and range",
  isTrustedProxy("::1") && isTrustedProxy("fd12:3456::9") && !isTrustedProxy("2001:db8::1"));

// Dual-stack listeners hand out ::ffff:10.0.0.1 routinely - and on Node this is
// exactly what socket.remoteAddress returns on a dual-stack bind, so an
// allow-list of 10.0.0.0/8 would silently miss without unmapping.
setTrusted("10.0.0.0/8");
assert("trusted proxy matches an ipv4 mapped ipv6 peer", isTrustedProxy("::ffff:10.0.0.1"));

setTrusted(undefined);
assert("trusted proxy is empty by default",
  trustedProxyNetworks().length === 0 && !isTrustedProxy("10.0.0.1"));

// A typo must not take the whole allow-list down with it.
setTrusted("10.0.0.0/8, not-an-ip, ::1");
assert("trusted proxy ignores a malformed entry",
  isTrustedProxy("10.1.2.3") && isTrustedProxy("::1") && !isTrustedProxy("192.168.0.1"));

// --------------------------------------------------------- forwarded-for chain
// A client can PREPEND to X-Forwarded-For; the proxy appends. So the leftmost
// entry is attacker-controlled even behind a real proxy.
setTrusted(TEST_PEER);
assert("client ip takes the rightmost untrusted hop",
  resolveClientIp({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, TEST_PEER) === "5.6.7.8");

setTrusted(`${TEST_PEER}, 5.6.7.8`);
assert("client ip skips hops that are themselves trusted proxies",
  resolveClientIp({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, TEST_PEER) === "1.2.3.4");

setTrusted(undefined);
assert("client ip is the peer when the peer is not trusted",
  resolveClientIp({ "x-forwarded-for": "1.2.3.4" }, "198.51.100.1") === "198.51.100.1");

setTrusted(TEST_PEER);
assert("client ip falls back to x real ip behind a trusted proxy",
  resolveClientIp({ "x-real-ip": "9.9.9.9" }, TEST_PEER) === "9.9.9.9");

setTrusted(undefined);
assert("client ip ignores x real ip from an untrusted peer",
  resolveClientIp({ "x-real-ip": "9.9.9.9" }, "198.51.100.1") === "198.51.100.1");

// A repeated header arrives as an array. The limiter's old inline derivation
// tested `typeof forwarded === "string"` and silently fell through to the
// socket address, disagreeing with req.ip which did read the array.
setTrusted(TEST_PEER);
assert("client ip reads a repeated forwarded for header",
  resolveClientIp({ "x-forwarded-for": ["1.2.3.4", "5.6.7.8"] }, TEST_PEER) === "5.6.7.8");

setTrusted(undefined);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
