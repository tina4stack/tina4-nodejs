/**
 * WebSocket Backplane Abstraction for Tina4 Node.js.
 *
 * Enables broadcasting WebSocket messages across multiple server instances
 * using a shared pub/sub channel (e.g. Redis). Without a backplane configured,
 * broadcast() only reaches connections on the local process.
 *
 * Configuration via environment variables:
 *   TINA4_WS_BACKPLANE     — Backend type: "redis", "nats", or "" (default: none)
 *   TINA4_WS_BACKPLANE_URL — Connection string (default: redis://localhost:6379)
 *
 * Usage:
 *   const backplane = createBackplane();
 *   if (backplane) {
 *     backplane.subscribe("chat", (msg) => relayToLocal(msg));
 *     backplane.publish("chat", '{"user":"A","text":"hello"}');
 *   }
 */
import { randomUUID } from "node:crypto";

/**
 * Base interface for scaling WebSocket broadcast across instances.
 *
 * Implementations relay messages over a shared bus so every server instance
 * receives every broadcast, not just the originator.
 */
export interface WebSocketBackplane {
  /** Publish a message to all instances listening on `channel`. */
  publish(channel: string, message: string): Promise<void>;

  /** Subscribe to `channel`. `callback` is invoked with each incoming message. */
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;

  /** Stop listening on `channel`. */
  unsubscribe(channel: string): Promise<void>;

  /** Tear down connections. */
  close(): Promise<void>;
}

/**
 * Redis pub/sub backplane.
 *
 * Requires the `redis` package (`npm install redis`). The import is deferred
 * so the rest of Tina4 works fine without it installed — an error is thrown
 * only when this class is actually instantiated.
 */
export class RedisBackplane implements WebSocketBackplane {
  private publisher: any;
  private subscriber: any;
  private url: string;
  private ready: Promise<void>;

  constructor(url?: string) {
    const resolvedUrl = url ?? process.env.TINA4_WS_BACKPLANE_URL ?? "redis://localhost:6379";
    this.url = resolvedUrl;

    this.ready = (async () => {
      let redis: any;
      try {
        // Optional peer dependency — resolved via a string specifier so the
        // module isn't required at type-check time when it isn't installed.
        const redisModule: string = "redis";
        redis = await import(redisModule);
      } catch {
        throw new Error(
          "The 'redis' package is required for RedisBackplane. " +
          "Install it with: npm install redis"
        );
      }

      this.publisher = redis.createClient({ url: resolvedUrl });
      this.subscriber = this.publisher.duplicate();

      await Promise.all([
        this.publisher.connect(),
        this.subscriber.connect(),
      ]);
      console.log(`[Tina4] RedisBackplane connected to ${resolvedUrl}`);
    })();
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.ready;
    await this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    await this.ready;
    await this.subscriber.subscribe(channel, (message: string) => {
      callback(message);
    });
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.ready;
    await this.subscriber.unsubscribe(channel);
  }

  async close(): Promise<void> {
    await this.publisher.quit();
    await this.subscriber.quit();
  }
}

/**
 * NATS pub/sub backplane.
 *
 * Requires the `nats` package (`npm install nats`). The import is deferred
 * so the rest of Tina4 works fine without it installed — an error is thrown
 * only when this class is actually instantiated.
 *
 * NATS is async-native. The subscription listener runs via the NATS client's
 * built-in async iteration.
 */
export class NATSBackplane implements WebSocketBackplane {
  private nc: any;
  private url: string;
  private subs: Map<string, any> = new Map();
  private ready: Promise<void>;

  constructor(url?: string) {
    const resolvedUrl = url ?? process.env.TINA4_WS_BACKPLANE_URL ?? "nats://localhost:4222";
    this.url = resolvedUrl;

    this.ready = (async () => {
      let nats: any;
      try {
        // Optional peer dependency — resolved via a string specifier so the
        // module isn't required at type-check time when it isn't installed.
        const natsModule: string = "nats";
        nats = await import(natsModule);
      } catch {
        throw new Error(
          "The 'nats' package is required for NATSBackplane. " +
          "Install it with: npm install nats"
        );
      }

      this.nc = await nats.connect({ servers: resolvedUrl });
      console.log(`[Tina4] NATSBackplane connected to ${resolvedUrl}`);
    })();
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.ready;
    const natsModule: string = "nats";
    const { StringCodec } = await import(natsModule);
    const sc = StringCodec();
    this.nc.publish(channel, sc.encode(message));
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    await this.ready;
    const natsModule: string = "nats";
    const { StringCodec } = await import(natsModule);
    const sc = StringCodec();
    const sub = this.nc.subscribe(channel);
    this.subs.set(channel, sub);

    // Process messages in the background via async iteration
    (async () => {
      for await (const msg of sub) {
        try {
          callback(sc.decode(msg.data));
        } catch { /* ignore callback errors */ }
      }
    })();
  }

  async unsubscribe(channel: string): Promise<void> {
    const sub = this.subs.get(channel);
    if (sub) {
      sub.unsubscribe();
      this.subs.delete(channel);
    }
  }

  async close(): Promise<void> {
    for (const sub of this.subs.values()) {
      sub.unsubscribe();
    }
    this.subs.clear();
    if (this.nc) {
      await this.nc.close();
    }
  }
}

/**
 * Factory that reads TINA4_WS_BACKPLANE and returns the appropriate
 * backplane instance, or `null` if no backplane is configured.
 *
 * This keeps backplane usage entirely optional — callers simply check
 * `if (backplane)` before publishing.
 */
export function createBackplane(url?: string): WebSocketBackplane | null {
  const backend = (process.env.TINA4_WS_BACKPLANE ?? "").trim().toLowerCase();

  switch (backend) {
    case "redis":
      return new RedisBackplane(url);
    case "nats":
      return new NATSBackplane(url);
    case "":
      return null;
    default:
      throw new Error(`Unknown TINA4_WS_BACKPLANE value: '${backend}'`);
  }
}

// ── Multi-instance scaling (backplane manager) ───────────────

/**
 * The shared pub/sub channel name. Identical across all four Tina4 frameworks
 * (cross-framework constant parity) so a Python, PHP, Ruby and Node instance
 * can all relay each other's broadcasts over the same bus.
 */
export const WS_BACKPLANE_CHANNEL = "tina4:ws";

/** What `kind` a broadcast envelope carries — mirrors the master design. */
export type WsEnvelopeKind = "all" | "path" | "room";

/**
 * The JSON envelope published to the backplane channel. The wire shape is
 * identical across all four frameworks. JSON can't carry bytes, so a string
 * message rides under `text` and a binary message rides under `b64`
 * (base64 of the bytes).
 */
export interface WsEnvelope {
  /** Stable per-process instance id of the publisher (for the origin guard). */
  src: string;
  /** Delivery kind: every local conn / a path / a room. */
  kind: WsEnvelopeKind;
  /** Optional connection id to skip on delivery. */
  exclude?: string | null;
  /** Room name (only when kind === "room"). */
  room?: string | null;
  /** Path (only when kind === "path"). */
  path?: string | null;
  /** Text payload (str messages). */
  text?: string;
  /** Base64 payload (binary messages). */
  b64?: string;
}

/**
 * Wires a {@link WebSocketBackplane} into a local connection manager so a
 * broadcast on one server instance reaches the local connections of every
 * sibling instance.
 *
 * Node is single-threaded async, so — unlike Python's bg-thread →
 * `run_coroutine_threadsafe` bridge — the subscribe callback can relay
 * directly on the event loop. We still apply the two invariants that keep a
 * cluster correct:
 *
 *   1. **Origin guard** — drop any envelope whose `src` is *this* instance's
 *      id. We already delivered it locally on broadcast; relaying it again
 *      would double-send.
 *   2. **No re-publish** — the relay path only delivers to LOCAL connections;
 *      it never publishes, so a message can't loop around the cluster.
 *
 * The manager is generic over the local-delivery callback (`relay`) so it can
 * sit beside the WebSocketServer without importing it (no module cycle).
 */
export class WsBackplaneManager {
  /** Stable per-process id so we can ignore our own echoes. */
  readonly instanceId: string;
  readonly channel: string;
  private backplane: WebSocketBackplane | null = null;
  private started = false;
  /** Local-delivery callback, installed by the owner (WebSocketServer). */
  private relay: ((env: WsEnvelope) => void) | null = null;

  constructor(channel: string = WS_BACKPLANE_CHANNEL) {
    this.instanceId = randomInstanceId();
    this.channel = channel;
  }

  /** True once a backplane is actually attached (a network bus is configured). */
  get active(): boolean {
    return this.backplane !== null;
  }

  /**
   * Lazily wire the configured backplane and subscribe. Idempotent and
   * best-effort — a failure here logs and leaves the manager in local-only
   * mode; it must NEVER crash a broadcast. The `relay` callback is invoked
   * (on this same event loop) for every *remote* envelope that survives the
   * origin guard.
   */
  async ensure(relay: (env: WsEnvelope) => void, log?: WsBackplaneLogger): Promise<void> {
    if (this.started) return;
    // Set immediately so we only ever attempt the wiring once, even if it
    // fails (no retry storm on every broadcast).
    this.started = true;
    this.relay = relay;
    try {
      const backplane = createBackplane();
      if (backplane === null) return; // No backplane configured — stay local-only.
      this.backplane = backplane;
      await backplane.subscribe(this.channel, (raw) => this.onMessage(raw));
      log?.info(
        `WebSocket backplane active (instance ${this.instanceId}, channel '${this.channel}')`,
      );
    } catch (err) {
      this.backplane = null;
      log?.error(
        `WebSocket backplane wiring failed, continuing local-only: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Handle a raw envelope arriving on the channel. Applies the origin guard
   * then hands a *remote* envelope to the local relay. Never throws (a
   * malformed envelope is dropped silently).
   */
  onMessage(raw: string): void {
    let env: unknown;
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof env !== "object" || env === null) return;
    const envelope = env as WsEnvelope;
    // Origin guard: ignore our own broadcasts echoed back over the channel.
    // We already delivered them locally; relaying again would double-send.
    if (envelope.src === this.instanceId) return;
    this.relay?.(envelope);
  }

  /**
   * Publish a broadcast to the shared channel for sibling instances. No-op
   * when no backplane is configured. Best-effort — a publish failure logs and
   * is swallowed so the local broadcast that already happened is never undone
   * by a flaky message bus.
   */
  publish(
    kind: WsEnvelopeKind,
    message: string | Buffer,
    opts: { room?: string | null; path?: string | null; exclude?: string | null } = {},
    log?: WsBackplaneLogger,
  ): void {
    if (!this.backplane) return;
    const envelope = buildEnvelope(this.instanceId, kind, message, opts);
    // publish() is async; we fire-and-forget but still catch a rejection so a
    // dead bus can't produce an unhandled rejection that crashes the worker.
    Promise.resolve(this.backplane.publish(this.channel, JSON.stringify(envelope))).catch(
      (err) => log?.warning(`WebSocket backplane publish failed: ${(err as Error).message}`),
    );
  }

  /**
   * Reconstruct the original str/Buffer message from an envelope. JSON can't
   * carry bytes, so `text` → string and `b64` → Buffer.
   */
  static decodeMessage(env: WsEnvelope): string | Buffer | null {
    if (typeof env.text === "string") return env.text;
    if (typeof env.b64 === "string") return Buffer.from(env.b64, "base64");
    return null;
  }
}

/** Minimal logger shape so the manager doesn't import the logger module. */
export interface WsBackplaneLogger {
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
}

/** Build the cross-framework envelope. Exported for tests. */
export function buildEnvelope(
  src: string,
  kind: WsEnvelopeKind,
  message: string | Buffer,
  opts: { room?: string | null; path?: string | null; exclude?: string | null } = {},
): WsEnvelope {
  const envelope: WsEnvelope = {
    src,
    kind,
    exclude: opts.exclude ?? null,
    room: opts.room ?? null,
    path: opts.path ?? null,
  };
  // JSON can't carry bytes — encode a string as text, bytes as base64.
  if (Buffer.isBuffer(message)) {
    envelope.b64 = message.toString("base64");
  } else {
    envelope.text = message;
  }
  return envelope;
}

/** A stable, short per-process id (16 hex chars), matching the master. */
function randomInstanceId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}
