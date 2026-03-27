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

    let redis: any;
    try {
      redis = require("redis");
    } catch {
      throw new Error(
        "The 'redis' package is required for RedisBackplane. " +
        "Install it with: npm install redis"
      );
    }

    this.publisher = redis.createClient({ url: this.url });
    this.subscriber = this.publisher.duplicate();

    this.ready = Promise.all([
      this.publisher.connect(),
      this.subscriber.connect(),
    ]).then(() => {
      console.log(`[Tina4] RedisBackplane connected to ${this.url}`);
    });
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
      throw new Error("NATS backplane is on the roadmap but not yet implemented.");
    case "":
      return null;
    default:
      throw new Error(`Unknown TINA4_WS_BACKPLANE value: '${backend}'`);
  }
}
