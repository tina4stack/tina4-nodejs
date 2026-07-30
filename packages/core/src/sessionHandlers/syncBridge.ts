/**
 * Tina4 sync-over-async bridge — call an ASYNC worker from SYNCHRONOUS code.
 *
 * The SessionHandler interface is synchronous; every backend client Node offers
 * (node:net, the mongodb driver) is async-only. The old resolution was to run
 * each command in a short-lived `node -e` child and block on execFileSync. That
 * works but pays a process spawn — and a fresh connection, and for Mongo a fresh
 * driver load — PER COMMAND. Measured on this machine: spawn min 38ms / p50 41ms
 * / p99 487ms, with a bare TCP connect adding a ~0.5-0.9s tail of its own. That
 * tail tripped the child's deadline under load, which is what made the Valkey
 * session tests flaky with the signature "a value that was just written reads
 * back null" — the write timed out for the caller while still landing on the
 * server.
 *
 * This is the ONE piece of plumbing that replaces it. A Worker thread keeps its
 * own event loop, so it can do ordinary async I/O and hold a long-lived
 * connection. The caller hands it a message with postMessage (delivered on the
 * WORKER's loop, so a blocked main thread cannot deadlock it), then blocks in
 * Atomics.wait until the worker writes a reply into a SharedArrayBuffer and
 * Atomics.notify wakes it.
 *
 * Every session backend that needs sync-over-async uses this — RESP
 * (Redis/Valkey), memcached's text protocol, and MongoDB — so the blocking
 * handshake exists once rather than once per backend.
 */
import { Worker } from "node:worker_threads";

/** Reply status, written by the worker into control[IDX_STATUS]. */
export const STATUS_OK = 0;
/** A healthy server answered with an error (RESP `-ERR`, a Mongo command error). */
export const STATUS_ERROR = 1;
/** A genuine miss — no such key/document. NOT a failure. */
export const STATUS_NIL = 2;
/** The reply did not fit the shared buffer. */
export const STATUS_TOO_LARGE = 3;
/** Connection/socket/driver failure, as opposed to an answer from a healthy server. */
export const STATUS_TRANSPORT = 4;

export const IDX_SEQ = 0;      // bumped by the worker on every reply; what Atomics.wait watches
export const IDX_LENGTH = 1;   // reply byte length
export const IDX_STATUS = 2;   // one of STATUS_*
export const IDX_READY = 3;    // set to 1 by the worker as soon as its loop is running

/**
 * Reply payload ceiling. A session document beyond this is pathological, and a
 * fixed buffer keeps the fast path allocation-free. A worker reports
 * STATUS_TOO_LARGE rather than truncating — a silently truncated session would
 * deserialise into garbage.
 */
export const DATA_BYTES = 8 * 1024 * 1024;

/** How long a caller blocks before giving up on a reply. */
export const REPLY_TIMEOUT_MS = 5000;

/**
 * How long the FIRST caller waits for a brand-new worker to come up.
 *
 * Boot and the command round-trip must not share one budget. Cold start is
 * normally ~27ms, but on a loaded machine (the session suite spawns a batch of
 * blocking Mongo children immediately beforehand) it can stretch — and when it
 * ate into the 5s command budget the very first Valkey write failed with
 * "timed out after 5000ms", which read exactly like the flake this transport
 * was built to remove. Boot gets its own generous budget so the per-command
 * timeout can stay tight and mean what it says.
 */
export const BOOT_TIMEOUT_MS = 15000;

/**
 * The worker-side helper, injected into every worker body. Kept here so the
 * reply protocol is written once: a worker only has to call
 * `__reply(status, payload)` and never touches Atomics itself.
 */
export const WORKER_REPLY_HELPER = `
const __control = new Int32Array(workerData.controlBuffer);
const __data = new Uint8Array(workerData.dataBuffer);
const __encoder = new TextEncoder();

// Announce readiness the moment this thread is executing. The parent blocks on
// this before its first command, so a slow boot can never be mistaken for a
// slow command. This is signalled by the worker's OWN bootstrap and needs no
// message from the parent, so it is safe even while the parent is blocked.
Atomics.store(__control, ${IDX_READY}, 1);
Atomics.notify(__control, ${IDX_READY});

function __reply(status, payload) {
  let length = 0;
  if (payload !== undefined && payload !== null && status !== ${STATUS_NIL}) {
    const bytes = __encoder.encode(String(payload));
    if (bytes.length > __data.length) {
      Atomics.store(__control, ${IDX_STATUS}, ${STATUS_TOO_LARGE});
      Atomics.store(__control, ${IDX_LENGTH}, 0);
      Atomics.add(__control, ${IDX_SEQ}, 1);
      Atomics.notify(__control, ${IDX_SEQ});
      return;
    }
    __data.set(bytes, 0);
    length = bytes.length;
  }
  Atomics.store(__control, ${IDX_STATUS}, status);
  Atomics.store(__control, ${IDX_LENGTH}, length);
  Atomics.add(__control, ${IDX_SEQ}, 1);
  Atomics.notify(__control, ${IDX_SEQ});
}
`;

export interface BridgeReply {
  status: number;
  payload: string;
}

export interface Bridge {
  /** Send a message to the worker and BLOCK until it replies. */
  call(message: unknown, label: string): BridgeReply;
  worker: Worker;
}

const bridges = new Map<string, Bridge>();

/**
 * Get (or create) the bridge for a key. One worker per key, created once and
 * unref'd so it can never hold the process open.
 *
 * @param key Identity of the connection target — same key, same worker
 * @param workerSource The worker body; WORKER_REPLY_HELPER is prepended for it
 * @param workerData Passed to the worker verbatim (plus the shared buffers)
 */
export function getBridge(key: string, workerSource: string, workerData: Record<string, unknown>): Bridge {
  const existing = bridges.get(key);
  if (existing) return existing;

  const controlBuffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
  const dataBuffer = new SharedArrayBuffer(DATA_BYTES);
  const control = new Int32Array(controlBuffer);
  const data = new Uint8Array(dataBuffer);

  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");\n${WORKER_REPLY_HELPER}\n${workerSource}`,
    { eval: true, workerData: { ...workerData, controlBuffer, dataBuffer } },
  );
  // A session channel must never keep a process alive.
  worker.unref();

  // Block until the worker is up. A cold channel pays this once.
  if (Atomics.load(control, IDX_READY) === 0) {
    if (Atomics.wait(control, IDX_READY, 0, BOOT_TIMEOUT_MS) === "timed-out") {
      void worker.terminate();
      bridges.delete(key);
      throw new Error(`session worker failed to start within ${BOOT_TIMEOUT_MS}ms`);
    }
  }

  const decoder = new TextDecoder();
  const bridge: Bridge = {
    worker,
    call(message: unknown, label: string): BridgeReply {
      // Watch a monotonic counter rather than a flag: a counter cannot race with
      // a reset, so a late reply from a previous (timed-out) call can never be
      // mistaken for this one's.
      const before = Atomics.load(control, IDX_SEQ);
      worker.postMessage(message);

      if (Atomics.wait(control, IDX_SEQ, before, REPLY_TIMEOUT_MS) === "timed-out") {
        throw new Error(`${label} command failed: timed out after ${REPLY_TIMEOUT_MS}ms`);
      }

      const status = Atomics.load(control, IDX_STATUS);
      const length = Atomics.load(control, IDX_LENGTH);

      if (status === STATUS_TOO_LARGE) {
        throw new Error(`${label} command failed: reply exceeds the ${DATA_BYTES} byte buffer`);
      }
      return { status, payload: decoder.decode(data.subarray(0, length)) };
    },
  };

  bridges.set(key, bridge);
  return bridge;
}

/**
 * Terminate every worker. Tests and short-lived scripts call this so a spawned
 * worker never outlives the work that created it — "reap what you spawn". Normal
 * apps do not need it: the workers are unref'd.
 */
export function closeBridges(): void {
  for (const { worker } of bridges.values()) {
    void worker.terminate();
  }
  bridges.clear();
}
