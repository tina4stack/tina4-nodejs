/**
 * Which upstream hops are allowed to speak for a client (ADR-0019).
 *
 * X-Forwarded-For is written by whoever sends it. Reading it unconditionally
 * lets any client choose its own rate-limit bucket, and - worse - choose
 * SOMEONE ELSE'S, which is a starvation primitive against a third party. So
 * the forwarding headers are believed only when the raw socket peer is a proxy
 * the operator has explicitly declared.
 *
 * Configured by TINA4_TRUSTED_PROXIES: comma-separated exact addresses and/or
 * CIDR ranges, IPv4 and IPv6, e.g. "10.0.0.0/8, 192.168.1.5, ::1, fd00::/8".
 * Empty or unset means trust NOTHING, which is the secure default.
 *
 * Zero-dependency: node: has no CIDR matcher, so the packing and prefix
 * comparison are done here over plain byte arrays.
 */

import { Log } from "./logger.js";

/** [packed network address, prefix bits] */
type Network = [Uint8Array, number];

// Parsed TINA4_TRUSTED_PROXIES, cached on the raw env string so a change is
// picked up but the parse does not run per request.
let cachedRaw: string | null = null;
let cachedNetworks: Network[] = [];

/**
 * Strip the decorations a peer address can arrive with: the "[::1]" bracket
 * form and an IPv6 zone id ("fe80::1%eth0").
 */
function normalise(value: string): string {
  let out = value.trim();
  if (out.startsWith("[")) {
    const close = out.indexOf("]");
    if (close !== -1) out = out.slice(1, close);
  }
  const pct = out.indexOf("%");
  if (pct !== -1) out = out.slice(0, pct);
  return out;
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // Reject "", "01", "1e2", "+1" and anything out of range. A permissive
    // parse here would let "10.0.0.01" or "10.0.0.1x" through as a match.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split("::");
  if (halves.length > 2) return null;

  const expand = (chunk: string): string[] => (chunk === "" ? [] : chunk.split(":"));
  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];

  // A trailing IPv4 literal (::ffff:10.0.0.1) occupies the last two groups.
  const groups: string[] = [];
  const consume = (source: string[], into: string[]): boolean => {
    for (let i = 0; i < source.length; i++) {
      const part = source[i];
      if (part.includes(".")) {
        if (i !== source.length - 1) return false;
        const v4 = parseIpv4(part);
        if (!v4) return false;
        into.push(((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return false;
      into.push(part);
    }
    return true;
  };

  const headGroups: string[] = [];
  const tailGroups: string[] = [];
  if (!consume(head, headGroups) || !consume(tail, tailGroups)) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (halves.length === 2) {
    if (missing < 0) return null;
    groups.push(...headGroups, ...Array(missing).fill("0"), ...tailGroups);
  } else {
    if (headGroups.length !== 8) return null;
    groups.push(...headGroups);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const n = parseInt(groups[i], 16);
    if (Number.isNaN(n)) return null;
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

/**
 * Pack an address to its bytes, unmapping IPv4-in-IPv6.
 *
 * A peer arriving as ::ffff:10.0.0.1 must match an allow-list entry of
 * 10.0.0.0/8 - dual-stack listeners hand out the mapped form routinely, and
 * Node's socket.remoteAddress is a common source of it.
 */
export function packAddress(value: string): Uint8Array | null {
  const address = normalise(value);
  if (address === "") return null;
  const packed = address.includes(":") ? parseIpv6(address) : parseIpv4(address);
  if (!packed) return null;
  if (packed.length === 16) {
    let mapped = true;
    for (let i = 0; i < 10; i++) {
      if (packed[i] !== 0) { mapped = false; break; }
    }
    if (mapped && packed[10] === 0xff && packed[11] === 0xff) {
      return packed.slice(12);
    }
  }
  return packed;
}

function parseNetwork(entry: string): Network | null {
  let address = entry;
  let bits: number | null = null;

  const slash = entry.lastIndexOf("/");
  if (slash !== -1) {
    address = entry.slice(0, slash).trim();
    const suffix = entry.slice(slash + 1).trim();
    if (!/^\d{1,3}$/.test(suffix)) return null;
    bits = Number(suffix);
  }

  const packed = packAddress(address);
  if (!packed) return null;

  const maxBits = packed.length * 8;
  if (bits === null) bits = maxBits;
  if (bits < 0 || bits > maxBits) return null;
  return [packed, bits];
}

/** Do the first `bits` bits of two packed addresses agree? */
function prefixMatches(candidate: Uint8Array, network: Uint8Array, bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let i = 0; i < wholeBytes; i++) {
    if (candidate[i] !== network[i]) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return (candidate[wholeBytes] & mask) === (network[wholeBytes] & mask);
}

/**
 * The configured trusted-proxy networks, parsed once per distinct config value.
 */
export function trustedProxyNetworks(): Network[] {
  const raw = process.env.TINA4_TRUSTED_PROXIES ?? "";
  if (raw === cachedRaw) return cachedNetworks;

  const networks: Network[] = [];
  for (const rawEntry of raw.split(",")) {
    const entry = normalise(rawEntry);
    if (entry === "") continue;

    const parsed = parseNetwork(entry);
    if (!parsed) {
      // Loud, and exactly once per distinct config value (the cache below
      // means this parse runs once). A silently-skipped entry would leave a
      // real proxy untrusted, which looks like the app over-limiting every
      // client - a very expensive typo to debug.
      Log.error(
        `TINA4_TRUSTED_PROXIES: ignoring invalid entry '${entry}' - ` +
        "expected an IP address or CIDR range, e.g. 10.0.0.0/8 or 192.168.1.5",
      );
      continue;
    }
    networks.push(parsed);
  }

  cachedRaw = raw;
  cachedNetworks = networks;
  return networks;
}

/** Is this address a configured trusted proxy? */
export function isTrustedProxy(address: string): boolean {
  const networks = trustedProxyNetworks();
  if (networks.length === 0 || !address) return false;

  const packed = packAddress(address);
  if (!packed) return false;

  for (const [network, bits] of networks) {
    if (network.length === packed.length && prefixMatches(packed, network, bits)) {
      return true;
    }
  }
  return false;
}

/** Reset the parsed cache. Test hook - config normally changes only at boot. */
export function resetTrustedProxyCache(): void {
  cachedRaw = null;
  cachedNetworks = [];
}

/**
 * Resolve the client IP, honouring forwarding headers ONLY behind a trusted proxy.
 *
 * Within the chain the RIGHTMOST entry that is not itself a trusted proxy wins.
 * Taking the leftmost would be no safer than trusting the header outright: a
 * client can prepend its own hop, and the proxy appends rather than replaces.
 * This is the algorithm Rack uses (Rack::Request#ip).
 */
export function resolveClientIp(
  headers: Record<string, string | string[] | undefined>,
  peer: string,
): string {
  if (!peer || !isTrustedProxy(peer)) return peer;

  const rawForwarded = headers["x-forwarded-for"];
  // A repeated header arrives as an array. Joining keeps every hop in order;
  // reading only element 0 would silently drop the rest of the chain.
  const forwarded = Array.isArray(rawForwarded) ? rawForwarded.join(",") : rawForwarded;
  if (forwarded && forwarded.trim() !== "") {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(hops[i])) return hops[i];
    }
    // Every hop is itself a trusted proxy - the peer is the best we have.
    return peer;
  }

  const rawRealIp = headers["x-real-ip"];
  const realIp = (Array.isArray(rawRealIp) ? rawRealIp[0] : rawRealIp)?.trim();
  return realIp || peer;
}
