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
    this.url = url ?? process.env.TINA4_WS_BACKPLANE_URL ?? "redis://localhost:6379";

    this.ready = (async () => {
      let redis: any;
      try {
        redis = await import("redis");
      } catch {
        throw new Error(
          "The 'redis' package is required for RedisBackplane. " +
          "Install it with: npm install redis"
        );
      }

      this.publisher = redis.createClient({ url: this.url });
      this.subscriber = this.publisher.duplicate();

      await Promise.all([
        this.publisher.connect(),
        this.subscriber.connect(),
      ]);
      console.log(`[Tina4] RedisBackplane connected to ${this.url}`);
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
    this.url = url ?? process.env.TINA4_WS_BACKPLANE_URL ?? "nats://localhost:4222";

    this.ready = (async () => {
      let nats: any;
      try {
        nats = await import("nats");
      } catch {
        throw new Error(
          "The 'nats' package is required for NATSBackplane. " +
          "Install it with: npm install nats"
        );
      }

      this.nc = await nats.connect({ servers: this.url });
      console.log(`[Tina4] NATSBackplane connected to ${this.url}`);
    })();
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.ready;
    const { StringCodec } = await import("nats");
    const sc = StringCodec();
    this.nc.publish(channel, sc.encode(message));
  }

  async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
    await this.ready;
    const { StringCodec } = await import("nats");
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
