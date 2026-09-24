/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/
/**
 * Medium security finding F6 — X-Forwarded-Host must only be honoured when the
 * raw socket peer is a trusted proxy (TINA4_TRUSTED_PROXIES, ADR-0019).
 *
 * An untrusted client can otherwise forge X-Forwarded-Host / X-Forwarded-Proto
 * and control the absolute `request.url` the app builds — the base for
 * password-reset links, cache keys, and open-redirect targets. The existing
 * trusted-proxy gate covered X-Forwarded-For only; this pins the same rule for
 * host/proto. Case names match the sibling regressions in
 * tina4-python/tests/test_forwarded_host_trust.py,
 * tina4-php/tests/ForwardedHostTrustTest.php and
 * tina4-ruby/spec/forwarded_host_trust_spec.rb.
 *
 * Real node:http server, real createRequest, real loopback peer. No doubles.
 *
 * Run with: npx tsx test/forwardedHostTrust.test.ts
 */
import http from "node:http";
import { createRequest } from "../packages/core/src/request.ts";
import { resetTrustedProxyCache } from "../packages/core/src/trustedProxy.ts";
import { freePort } from "./freePort.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
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
 * A real server that echoes the resolved `request.url` back to the caller. The
 * socket peer is 127.0.0.1 (loopback), so whether the peer is trusted is
 * controlled purely by listing or not listing that address.
 */
async function withEchoServer(
  run: (hit: (forwardedHost: string, forwardedProto?: string) => Promise<string>) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const server = http.createServer((raw, rawRes) => {
    const req = createRequest(raw);
    rawRes.writeHead(200, { "content-type": "text/plain" });
    rawRes.end(req.url ?? "");
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const hit = (forwardedHost: string, forwardedProto?: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { "X-Forwarded-Host": forwardedHost };
      if (forwardedProto) headers["X-Forwarded-Proto"] = forwardedProto;
      const r = http.request(
        { host: "127.0.0.1", port, path: "/reset-link", method: "GET", headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve(body));
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

console.log("\n  X-Forwarded-Host trust (F6)\n");

// Untrusted peer: the forged host must be IGNORED — request.url keeps the real host.
setTrusted(undefined);
await withEchoServer(async (hit) => {
  const url = await hit("evil.com", "https");
  assert(
    "forwarded host and proto share raw peer trust: untrusted peer: X-Forwarded-Host and Proto are ignored for request.url",
    new URL(url).protocol === "http:" && new URL(url).hostname === "127.0.0.1",
    `forged host leaked into request.url: ${url}`,
  );
});

// Trusted peer: real deployments behind a proxy must still see the forwarded host.
setTrusted("127.0.0.1/8");
await withEchoServer(async (hit) => {
  const url = await hit("app.example.com", "https");
  assert(
    "forwarded host and proto share raw peer trust: trusted peer: X-Forwarded-Host and Proto are honoured for request.url",
    new URL(url).protocol === "https:" && new URL(url).hostname === "app.example.com",
    `forwarded host not honoured behind a trusted proxy: ${url}`,
  );
});
setTrusted(undefined);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
