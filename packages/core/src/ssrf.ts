/**
 * Outbound SSRF guard (ADR-0084).
 *
 * The Api client and Web Push refuse, by default, to connect to a private or
 * internal address. Before each connection - the initial URL and every redirect
 * hop the Api client follows - the host is resolved to its IP address(es) and
 * the request is refused if any resolved address is loopback, private,
 * link-local (including the cloud metadata address 169.254.169.254), unspecified
 * or CGNAT. A non-http(s) scheme is refused.
 *
 * Off by default; TINA4_ALLOW_PRIVATE_REQUESTS (truthy) or an explicit allow-list
 * of hosts / host:port / CIDRs opts out. Zero external dependencies - node:net +
 * node:dns.
 */
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export const ALLOW_PRIVATE_ENV = "TINA4_ALLOW_PRIVATE_REQUESTS";

/** Truthiness identical to ADR-0070's set (trimmed, lower-cased). */
const TRUTHY: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);

/** Raised when the SSRF guard refuses an outbound request. */
export class SsrfError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SsrfError";
    }
}

interface Cidr {
    net: Uint8Array;
    bits: number;
}

/**
 * The blocked address space, one definition shared with the contract fixture.
 * 0.0.0.0/8 covers the unspecified address and the "this network" block.
 */
const BLOCKED_CIDRS: readonly string[] = [
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
    "::1/128", "::/128", "fc00::/7", "fe80::/10",
];

function v4ToBytes(ip: string): Uint8Array | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
        const n = Number(parts[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255 || !/^\d+$/.test(parts[i])) return null;
        bytes[i] = n;
    }
    return bytes;
}

function v6ToBytes(input: string): Uint8Array | null {
    let ip = input.split("%")[0];
    // Embedded IPv4 tail (::ffff:1.2.3.4).
    const lastColon = ip.lastIndexOf(":");
    const tail = ip.slice(lastColon + 1);
    if (tail.includes(".")) {
        const v4 = v4ToBytes(tail);
        if (!v4) return null;
        const hextetA = ((v4[0] << 8) | v4[1]).toString(16);
        const hextetB = ((v4[2] << 8) | v4[3]).toString(16);
        ip = ip.slice(0, lastColon + 1) + hextetA + ":" + hextetB;
    }
    const halves = ip.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const back = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
    let groups: string[];
    if (halves.length === 1) {
        if (head.length !== 8) return null;
        groups = head;
    } else {
        const missing = 8 - (head.length + back.length);
        if (missing < 0) return null;
        groups = [...head, ...Array(missing).fill("0"), ...back];
    }
    if (groups.length !== 8) return null;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
        const g = parseInt(groups[i], 16);
        bytes[i * 2] = (g >> 8) & 0xff;
        bytes[i * 2 + 1] = g & 0xff;
    }
    return bytes;
}

/** Parse an IP string (v4 or v6, IPv4-mapped included) to its packed bytes. */
function ipToBytes(ip: string): Uint8Array | null {
    const cleaned = ip.split("%")[0];
    const family = isIP(cleaned);
    if (family === 4) return v4ToBytes(cleaned);
    if (family === 6) {
        const bytes = v6ToBytes(cleaned);
        if (!bytes) return null;
        // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d) to its 4-byte IPv4.
        const isMapped = bytes.subarray(0, 10).every((b) => b === 0)
            && bytes[10] === 0xff && bytes[11] === 0xff;
        return isMapped ? bytes.subarray(12) : bytes;
    }
    return null;
}

function parseCidr(cidr: string): Cidr | null {
    const [netStr, bitsStr] = cidr.split("/");
    const net = ipToBytes(netStr);
    if (!net) return null;
    return { net, bits: Number(bitsStr) };
}

const BLOCKED: readonly Cidr[] = BLOCKED_CIDRS
    .map(parseCidr)
    .filter((c): c is Cidr => c !== null);

function inCidr(packed: Uint8Array, cidr: Cidr): boolean {
    if (packed.length !== cidr.net.length) return false;
    const whole = Math.floor(cidr.bits / 8);
    const remainder = cidr.bits % 8;
    for (let i = 0; i < whole; i++) {
        if (packed[i] !== cidr.net[i]) return false;
    }
    if (remainder === 0) return true;
    const mask = (0xff << (8 - remainder)) & 0xff;
    return (packed[whole] & mask) === (cidr.net[whole] & mask);
}

/** True when TINA4_ALLOW_PRIVATE_REQUESTS opts out of the guard. */
export function allowPrivateRequests(): boolean {
    return TRUTHY.has((process.env[ALLOW_PRIVATE_ENV] ?? "").trim().toLowerCase());
}

/**
 * Classify one IP string: true = private/internal, refuse it. An IPv4-mapped
 * IPv6 address is classified by its embedded IPv4. An unparseable value is
 * treated as blocked - the guard refuses what it cannot classify.
 */
export function isBlockedAddress(ip: string): boolean {
    const packed = ipToBytes(ip);
    if (!packed) return true;
    return BLOCKED.some((cidr) => inCidr(packed, cidr));
}

function matchesAllowList(host: string, port: number, resolved: string[], allowHosts?: string[]): boolean {
    const hostLower = host.toLowerCase();
    for (const raw of allowHosts ?? []) {
        const entry = String(raw).trim().toLowerCase();
        if (!entry) continue;
        if (entry === hostLower || entry === `${hostLower}:${port}`) return true;
        if (entry.includes("/")) {
            const cidr = parseCidr(entry);
            if (cidr && resolved.some((ip) => {
                const packed = ipToBytes(ip);
                return packed !== null && inCidr(packed, cidr);
            })) {
                return true;
            }
        }
    }
    return false;
}

function logBlock(host: string, ip: string): void {
    // Log lazily to avoid a hard dependency cycle with the logger.
    void import("./logger.js")
        .then((mod) => mod.Log?.warning?.(`SSRF guard blocked outbound request to ${host} (${ip})`))
        .catch(() => undefined);
}

/**
 * Refuse `url` when it targets a private/internal address. Throws SsrfError for a
 * non-http(s) scheme, an unresolvable host, or any resolved address in the
 * blocked space. `allowHosts` is a list of hosts / host:port / CIDRs to permit.
 */
export async function guardUrl(url: string, allowHosts?: string[]): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new SsrfError(`Blocked request: '${url}' is not a valid URL`);
    }
    const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
        throw new SsrfError(`Blocked request: URL scheme '${scheme || "(none)"}' is not http or https`);
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (!host) {
        throw new SsrfError("Blocked request: URL has no host");
    }
    const port = parsed.port ? Number(parsed.port) : (scheme === "https" ? 443 : 80);

    if (allowPrivateRequests()) return;

    let resolved: string[];
    try {
        const results = await lookup(host, { all: true });
        resolved = results.map((r) => r.address);
    } catch {
        throw new SsrfError(`Blocked request to ${host}: cannot resolve host`);
    }
    if (resolved.length === 0) {
        throw new SsrfError(`Blocked request to ${host}: cannot resolve host`);
    }

    if (matchesAllowList(host, port, resolved, allowHosts)) return;

    for (const ip of resolved) {
        if (isBlockedAddress(ip)) {
            logBlock(host, ip);
            throw new SsrfError(
                `Blocked request to private/internal address ${ip} (host ${host}): ` +
                `set ${ALLOW_PRIVATE_ENV}=true to allow, or pass an allow-list.`,
            );
        }
    }
}
