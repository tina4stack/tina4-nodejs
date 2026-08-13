/**
 * Identity-checked port takeover, shared by the CLI and the runtime paths.
 *
 * `tina4 serve` reclaims a busy port so the edit-restart loop does not fail with
 * "address already in use". The convenience has a sharp edge: "whatever is
 * listening" is not always the old Tina4 server, and before this module BOTH
 * takeover paths (the CLI `killProcessOnPort` and the runtime bind-failure
 * `killPort`) SIGTERM'd whatever held the port, with NO check that the victim was
 * a Tina4 dev server -- a foreign holder (another dev server, a database, a stray
 * listener) was killed.
 *
 * This is the ONE takeover implementation both paths call (TAKEOVER-DEC-02), so
 * the runtime path can never again be a weaker twin of the CLI path. It adds:
 *
 *  - Identity (TAKEOVER-DEC-01): a Tina4 dev server writes a per-port PID file
 *    (`data/.tina4-serve-<port>.pid`) when it binds and removes it on clean exit.
 *    Takeover only signals a holder whose PID matches that file; a holder with no
 *    matching Tina4 PID file is REFUSED, never killed.
 *  - Dev gate + opt-out (TAKEOVER-DEC-03): takeover runs only in dev
 *    (`TINA4_DEBUG` truthy) and only when not opted out (`TINA4_NO_TAKEOVER` /
 *    `tina4 serve --no-kill`). A production bind never kills a port holder.
 *  - The existing PID safety filter and container guard, unchanged, on top.
 *
 * Refusing is always safe (the developer frees the port by hand); over-killing
 * was the bug this fixes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const TAKEOVER_NOTHING = "nothing";
export const TAKEOVER_KILLED = "killed";
export const TAKEOVER_REFUSED_FOREIGN = "refused_foreign";
export const TAKEOVER_REFUSED_OPTOUT = "refused_optout";
export const TAKEOVER_REFUSED_PROD = "refused_prod";
export const TAKEOVER_SKIPPED_CONTAINER = "skipped_container";
/** Statuses that mean a holder was left running on purpose. */
export const TAKEOVER_REFUSALS = [
  TAKEOVER_REFUSED_FOREIGN,
  TAKEOVER_REFUSED_OPTOUT,
  TAKEOVER_REFUSED_PROD,
];

export interface TakeoverResult {
  status: string;
  port: number;
  killed: number[];
  message: string;
}

function isTruthy(value: string | undefined): boolean {
  return ["true", "1", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

/** Dev mode = TINA4_DEBUG truthy. Takeover runs only in dev. */
export function isDev(): boolean {
  return isTruthy(process.env.TINA4_DEBUG);
}

/** True when takeover is disabled via TINA4_NO_TAKEOVER. */
export function noTakeoverOptedOut(): boolean {
  return isTruthy(process.env.TINA4_NO_TAKEOVER);
}

/**
 * True when this process is running inside a container. Reclaiming a port makes
 * sense on a dev machine; inside a container the server IS the container, so
 * there is no stale sibling to reclaim from.
 */
export function inContainer(): boolean {
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
  try {
    const blob = readFileSync("/proc/1/cgroup", "utf-8");
    return blob.includes("docker") || blob.includes("containerd") || blob.includes("kubepods");
  } catch {
    return false;
  }
}

/**
 * The PIDs from `lsof -ti` output that are safe to signal.
 *
 * Pure so the safety rule can be tested directly. A non-numeric field parses to
 * NaN/0, and signalling PID 0 hits EVERY process in the caller's own process
 * group -- the server kills itself. Accept only all-digit tokens; never PID 0
 * (our group), PID 1 (init), ourselves, or our own process group. This is the
 * PID-SAFETY gate only; whether a survivor is a Tina4 server is the SEPARATE
 * identity check in takeOverPort().
 */
export function selectablePids(lsofOutput: string, me: number, myGroup?: number): number[] {
  const pids: number[] = [];
  for (const token of lsofOutput.split(/\s+/)) {
    if (!/^\d+$/.test(token)) continue; // never coerce junk into a PID
    const pid = Number(token);
    if (pid <= 1 || pid === me) continue; // 0 = our group, 1 = init, me = suicide
    if (myGroup !== undefined && pid === myGroup) continue;
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

export function runtimeDir(baseDir?: string): string {
  return baseDir ?? join(process.cwd(), "data");
}

export function pidfilePath(port: number, baseDir?: string): string {
  return join(runtimeDir(baseDir), `.tina4-serve-${port}.pid`);
}

/** Record THIS process as the Tina4 dev server on `port` (best-effort). */
export function writePidfile(port: number, baseDir?: string, pid?: number): void {
  try {
    mkdirSync(runtimeDir(baseDir), { recursive: true });
    writeFileSync(pidfilePath(port, baseDir), String(pid ?? process.pid));
  } catch {
    /* identity is a convenience; never let it break the server */
  }
}

/** The PID a Tina4 dev server recorded for `port`, or null if none/garbage. */
export function readPidfile(port: number, baseDir?: string): number | null {
  try {
    const token = readFileSync(pidfilePath(port, baseDir), "utf-8").trim();
    return /^\d+$/.test(token) ? Number(token) : null;
  } catch {
    return null;
  }
}

/** Drop the PID file for `port` (clean shutdown, or after reclaiming it). */
export function removePidfile(port: number, baseDir?: string): void {
  try {
    unlinkSync(pidfilePath(port, baseDir));
  } catch {
    /* ignore */
  }
}

/** Raw lsof/netstat PID tokens for whatever holds `port`. */
function portHolders(port: number): string[] {
  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf-8", timeout: 5000 });
      const tokens: string[] = [];
      for (const line of out.split("\n")) {
        if (line.includes(`:${port}`) && (line.includes("LISTENING") || line.includes("ESTABLISHED"))) {
          const parts = line.trim().split(/\s+/);
          const last = parts[parts.length - 1];
          if (/^\d+$/.test(last)) tokens.push(last);
        }
      }
      return tokens;
    } catch {
      return [];
    }
  }
  try {
    return execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf-8", timeout: 5000 })
      .split(/\s+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A real synchronous pause, so the OS can reclaim the port -- no subprocess. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reclaim `port` ONLY from an identity-confirmed Tina4 dev server. The single
 * guarded path for both the CLI (`tina4 serve`) and the runtime bind-failure
 * fallback. `dev`/`noTakeover` are passed in so this stays pure and directly
 * testable; callers resolve them from isDev() / noTakeoverOptedOut().
 */
export function takeOverPort(
  port: number,
  dev: boolean,
  noTakeover: boolean,
  baseDir?: string,
  grace = 500,
): TakeoverResult {
  const make = (status: string, killed: number[] = [], message = ""): TakeoverResult => ({
    status,
    port,
    killed,
    message,
  });

  if (noTakeover) {
    return make(TAKEOVER_REFUSED_OPTOUT, [],
      `Port ${port} is in use and takeover is disabled (TINA4_NO_TAKEOVER/--no-kill) `
      + `-- free it or choose another port.`);
  }
  if (!dev) {
    return make(TAKEOVER_REFUSED_PROD, [],
      `Port ${port} is in use; takeover is disabled outside dev mode `
      + `-- free it or choose another port.`);
  }
  if (inContainer()) return make(TAKEOVER_SKIPPED_CONTAINER);

  const tokens = portHolders(port);
  if (tokens.length === 0) return make(TAKEOVER_NOTHING);

  const holders = selectablePids(tokens.join(" "), process.pid);
  if (holders.length === 0) return make(TAKEOVER_NOTHING);

  const recorded = readPidfile(port, baseDir);
  const tina4Holders = recorded === null ? [] : holders.filter((pid) => pid === recorded);
  if (tina4Holders.length === 0) {
    return make(TAKEOVER_REFUSED_FOREIGN, [],
      `Port ${port} is held by a non-Tina4 process -- free it or choose another port.`);
  }

  const killed: number[] = [];
  for (const pid of tina4Holders) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      /* already gone or no permission */
    }
  }
  if (killed.length === 0) return make(TAKEOVER_NOTHING);

  removePidfile(port, baseDir);
  sleepSync(grace);
  return make(TAKEOVER_KILLED, killed,
    `Reclaimed port ${port} from Tina4 dev server (PID: ${killed.join(", ")}).`);
}
