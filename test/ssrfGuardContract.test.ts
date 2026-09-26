/**
 * SSRF guard (ADR-0084) - the Node runner for ssrf_guard_contract.json.
 *
 * test/fixtures/ssrf_guard_contract.json is a copy of
 * tina4-documentation/plan/v3/fixtures/ssrf_guard_contract.json. Every address
 * in the fixture is fed to the real classifier; the request cases drive the real
 * Api client and the real Push sender against a REAL loopback http server - no
 * mocks. 127.0.0.1 is blocked by default, so the listener is reached via the
 * explicit allow-list; the opt-out has a positive twin.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { Api } from "../packages/core/src/api.ts";
import { Push, PushError } from "../packages/core/src/push.ts";
import { isBlockedAddress, guardUrl, SsrfError, ALLOW_PRIVATE_ENV } from "../packages/core/src/ssrf.ts";

interface Fixture {
    addresses: { ip: string; blocked: boolean; category: string }[];
    schemes: { scheme: string; allowed: boolean }[];
}

const FIXTURE = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "ssrf_guard_contract.json"), "utf8"),
) as Fixture;

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({
                port,
                close: () => new Promise<void>((r) => server.close(() => r())),
            });
        });
    });
}

const okServer = () => startServer((req, res) => {
    if (req.method === "POST") {
        res.writeHead(201).end();
    } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
    }
});

const redirectServer = () => startServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end();
});

describe("SSRF guard (ADR-0084)", () => {
    beforeEach(() => {
        delete process.env[ALLOW_PRIVATE_ENV];
    });
    afterEach(() => {
        delete process.env[ALLOW_PRIVATE_ENV];
    });

    // ── SSRF-CLASSIFY ─────────────────────────────────────────────────────────

    it("blocks loopback by default", () => {
        expect(isBlockedAddress("127.0.0.1")).toBe(true);
        expect(isBlockedAddress("::1")).toBe(true);
    });

    it("blocks cloud metadata address", () => {
        expect(isBlockedAddress("169.254.169.254")).toBe(true);
    });

    it("blocks private and cgnat ranges", () => {
        for (const c of FIXTURE.addresses) {
            expect(isBlockedAddress(c.ip), c.ip).toBe(c.blocked);
        }
    });

    it("allows a public address", () => {
        expect(isBlockedAddress("8.8.8.8")).toBe(false);
        expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    });

    it("rejects a non http scheme", async () => {
        for (const c of FIXTURE.schemes) {
            if (c.allowed) continue;
            await expect(guardUrl(`${c.scheme}://example.com/x`)).rejects.toBeInstanceOf(SsrfError);
        }
    });

    // ── SSRF-REQUEST ──────────────────────────────────────────────────────────

    it("api blocks request to loopback by default", async () => {
        const server = await okServer();
        try {
            const result = await new Api(`http://127.0.0.1:${server.port}`).get("/");
            expect(result.http_code).toBeNull();
            expect(result.error).toContain(ALLOW_PRIVATE_ENV);
        } finally {
            await server.close();
        }
    });

    it("api allows request with opt out", async () => {
        const server = await okServer();
        try {
            process.env[ALLOW_PRIVATE_ENV] = "true";
            const result = await new Api(`http://127.0.0.1:${server.port}`).get("/");
            expect(result.http_code).toBe(200);

            // and the explicit allow-list works with the opt-out OFF
            delete process.env[ALLOW_PRIVATE_ENV];
            const allowed = await new Api(`http://127.0.0.1:${server.port}`, { allowHosts: ["127.0.0.1"] }).get("/");
            expect(allowed.http_code).toBe(200);
        } finally {
            await server.close();
        }
    });

    it("api blocks redirect hop to private", async () => {
        const server = await redirectServer();
        try {
            // The loopback listener is allowed by the allow-list; its 302 target
            // (169.254.169.254) is NOT, so it is refused at the hop.
            const result = await new Api(`http://127.0.0.1:${server.port}`, { allowHosts: ["127.0.0.1"] }).get("/");
            expect(result.http_code).toBeNull();
            expect(result.error).toContain("169.254.169.254");
        } finally {
            await server.close();
        }
    });

    it("web push blocked to private endpoint unless opted in", async () => {
        const keys = Push.generateKeys();
        const subscription = {
            endpoint: "http://169.254.169.254/push/AAA",
            keys: { p256dh: Push.generateKeys().publicKey, auth: "AAAAAAAAAAAAAAAAAAAAAA" },
        };
        const push = new Push({ subject: "mailto:ops@example.com", publicKey: keys.publicKey, privateKey: keys.privateKey });
        await expect(push.send(subscription, { title: "hi" })).rejects.toThrow(PushError);
        await expect(push.send(subscription, { title: "hi" })).rejects.toThrow(ALLOW_PRIVATE_ENV);
    });
});
