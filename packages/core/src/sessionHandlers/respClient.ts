/**
 * Tina4 synchronous RESP transport — shared by every Redis/Valkey session handler.
 *
 * The session-handler interface is synchronous but node:net is async-only, so
 * this delegates to syncSocket, which owns ONE persistent connection per target
 * behind a worker thread. See that file for why: the previous implementation ran
 * every command in a short-lived `node -e` child, paying a process spawn AND a
 * fresh TCP connection per command (p50 41ms, p99 487ms), and its long tail
 * tripped the child's own deadline — the cause of the sessionHandlers flake.
 *
 * This module stays as the RESP-shaped seam the Redis/Valkey handlers call, so
 * neither has to know how the synchronous transport is implemented.
 */
import { syncCommand } from "./syncSocket.js";

export interface RespTarget {
  host: string;
  port: number;
  /** AUTH password (empty/undefined = no AUTH sent). */
  password?: string;
  /** SELECT db index (0/undefined = no SELECT sent). */
  db?: number;
}

/**
 * Run a single RESP command synchronously against host:port and return the reply.
 *
 * - A genuine nil / key-miss returns `""` (callers treat "" as "no session yet").
 * - A transport FAILURE (server unreachable, timeout, connection closed before a
 *   reply) THROWS `<label> command failed: ...`.
 * - A RESP error reply — including a rejected AUTH/SELECT handshake — THROWS
 *   `<label> error: ...`. A rejected handshake is a transport failure, not a
 *   result, so it is surfaced ahead of the command reply.
 *
 * The miss/failure split is the whole contract: collapsing them is how a dead
 * backend silently logs every user out instead of surfacing an outage.
 */
export function respCommandSync(target: RespTarget, args: string[], label = "Redis"): string {
  return syncCommand(
    { host: target.host, port: target.port, password: target.password, db: target.db },
    args,
    label,
  );
}
