/**
 * Tina4 RabbitMQ Queue Backend — AMQP 0-9-1 via raw TCP, zero dependencies.
 *
 * Implements the same interface as the file-based queue but uses RabbitMQ
 * for message storage and delivery.
 *
 * Configure via environment variables:
 *   TINA4_QUEUE_URL         — AMQP URL (amqp://[user:pass@]host:port[/vhost])
 *   TINA4_RABBITMQ_HOST     (override; default: "localhost")
 *   TINA4_RABBITMQ_PORT     (override; default: 5672)
 *   TINA4_RABBITMQ_USERNAME (override; default: "guest")
 *   TINA4_RABBITMQ_PASSWORD (override; default: "guest")
 *   TINA4_RABBITMQ_VHOST    (override; default: "/")
 *
 * Precedence per field: specific TINA4_RABBITMQ_* var (if set)
 *   > value derived from TINA4_QUEUE_URL > existing default.
 */
import net from "node:net";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { QueueJob } from "../queue.js";

// ── Types ────────────────────────────────────────────────────

export interface RabbitMQConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  vhost?: string;
  /**
   * Accepted for API parity with the file/MongoDB backends and IGNORED — the
   * broker owns redelivery (unacked messages requeue on channel close), so the
   * framework-level visibility timeout does not apply here.
   */
  visibilityTimeout?: number;
}

/**
 * Parse an AMQP URL (amqp://[user:pass@]host[:port][/vhost]) into a partial
 * RabbitMQConfig. Mirrors the Python/PHP/Ruby `parse_amqp_url` semantics:
 * strips a leading amqp:// or amqps:// scheme, splits optional credentials,
 * and prepends a leading "/" to the vhost when missing. Only fields present
 * in the URL are populated.
 */
export function parseAmqpUrl(url: string): RabbitMQConfig {
  const config: RabbitMQConfig = {};
  let rest = url.replace(/^amqps:\/\//, "").replace(/^amqp:\/\//, "");

  const atIndex = rest.indexOf("@");
  if (atIndex !== -1) {
    const creds = rest.slice(0, atIndex);
    rest = rest.slice(atIndex + 1);
    const colonIndex = creds.indexOf(":");
    if (colonIndex !== -1) {
      config.username = creds.slice(0, colonIndex);
      config.password = creds.slice(colonIndex + 1);
    } else {
      config.username = creds;
    }
  }

  let hostport = rest;
  const slashIndex = rest.indexOf("/");
  if (slashIndex !== -1) {
    hostport = rest.slice(0, slashIndex);
    const vhost = rest.slice(slashIndex + 1);
    if (vhost) {
      config.vhost = vhost.startsWith("/") ? vhost : "/" + vhost;
    }
  }

  const portColon = hostport.indexOf(":");
  if (portColon !== -1) {
    config.host = hostport.slice(0, portColon);
    config.port = parseInt(hostport.slice(portColon + 1), 10);
  } else if (hostport) {
    config.host = hostport;
  }

  return config;
}

export interface QueueBackend {
  push(queue: string, payload: unknown, delay?: number): string;
  pop(queue: string): QueueJob | null;
  size(queue: string): number;
  clear(queue: string): void;
}

// ── AMQP 0-9-1 Constants ────────────────────────────────────

const AMQP_PROTOCOL_HEADER = Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]); // "AMQP" + 0.9.1

// Frame types
const FRAME_METHOD = 1;
const FRAME_HEADER = 2;
const FRAME_BODY = 3;
const FRAME_HEARTBEAT = 8;
const FRAME_END = 0xce;

// Class/method IDs
const CONNECTION_START = (10 << 16) | 10;
const CONNECTION_START_OK = (10 << 16) | 11;
const CONNECTION_TUNE = (10 << 16) | 30;
const CONNECTION_TUNE_OK = (10 << 16) | 31;
const CONNECTION_OPEN = (10 << 16) | 40;
const CONNECTION_OPEN_OK = (10 << 16) | 41;
const CONNECTION_CLOSE = (10 << 16) | 50;
const CONNECTION_CLOSE_OK = (10 << 16) | 51;
const CHANNEL_OPEN = (20 << 16) | 10;
const CHANNEL_OPEN_OK = (20 << 16) | 11;
const CHANNEL_CLOSE = (20 << 16) | 40;
const CHANNEL_CLOSE_OK = (20 << 16) | 41;
const QUEUE_DECLARE = (50 << 16) | 10;
const QUEUE_DECLARE_OK = (50 << 16) | 11;
const BASIC_PUBLISH = (60 << 16) | 40;
const BASIC_GET = (60 << 16) | 70;
const BASIC_GET_OK = (60 << 16) | 71;
const BASIC_GET_EMPTY = (60 << 16) | 72;
const BASIC_ACK = (60 << 16) | 80;

// ── AMQP Helpers ─────────────────────────────────────────────

function writeShortString(buf: Buffer, offset: number, str: string): number {
  const len = Buffer.byteLength(str, "utf-8");
  buf.writeUInt8(len, offset);
  buf.write(str, offset + 1, len, "utf-8");
  return offset + 1 + len;
}

function writeLongString(buf: Buffer, offset: number, str: string): number {
  const len = Buffer.byteLength(str, "utf-8");
  buf.writeUInt32BE(len, offset);
  buf.write(str, offset + 4, len, "utf-8");
  return offset + 4 + len;
}

function writeTable(table: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(table)) {
    const keyBuf = Buffer.alloc(1 + Buffer.byteLength(key));
    writeShortString(keyBuf, 0, key);
    parts.push(keyBuf);

    // Type 'S' for long string
    const valBuf = Buffer.alloc(1 + 4 + Buffer.byteLength(value));
    valBuf.writeUInt8(83, 0); // 'S'
    writeLongString(valBuf, 1, value);
    parts.push(valBuf);
  }
  const tableData = Buffer.concat(parts);
  const result = Buffer.alloc(4 + tableData.length);
  result.writeUInt32BE(tableData.length, 0);
  tableData.copy(result, 4);
  return result;
}

function buildMethodFrame(channel: number, classMethod: number, payload: Buffer): Buffer {
  const framePayload = Buffer.alloc(4 + payload.length);
  framePayload.writeUInt16BE((classMethod >> 16) & 0xffff, 0);
  framePayload.writeUInt16BE(classMethod & 0xffff, 2);
  payload.copy(framePayload, 4);

  const frame = Buffer.alloc(7 + framePayload.length + 1);
  frame.writeUInt8(FRAME_METHOD, 0);
  frame.writeUInt16BE(channel, 1);
  frame.writeUInt32BE(framePayload.length, 3);
  framePayload.copy(frame, 7);
  frame.writeUInt8(FRAME_END, 7 + framePayload.length);
  return frame;
}

// ── RabbitMQ Backend ─────────────────────────────────────────

/**
 * RabbitMQ queue backend using raw AMQP 0-9-1 protocol.
 *
 * Uses synchronous-style communication by spawning a child process
 * for each operation, similar to the Redis session handler pattern.
 * This keeps the interface synchronous as required by the Queue class.
 */
export class RabbitMQBackend implements QueueBackend {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private vhost: string;

  constructor(config?: RabbitMQConfig) {
    // Base layer: values derived from TINA4_QUEUE_URL (parsed as an AMQP URL).
    const url = process.env.TINA4_QUEUE_URL;
    const fromUrl = url ? parseAmqpUrl(url) : {};

    // Precedence per field: explicit config arg > specific TINA4_RABBITMQ_* var
    // > value from TINA4_QUEUE_URL > existing default.
    this.host = config?.host ?? process.env.TINA4_RABBITMQ_HOST ?? fromUrl.host ?? "localhost";
    this.port = config?.port
      ?? (process.env.TINA4_RABBITMQ_PORT ? parseInt(process.env.TINA4_RABBITMQ_PORT, 10) : undefined)
      ?? fromUrl.port ?? 5672;
    this.username = config?.username ?? process.env.TINA4_RABBITMQ_USERNAME ?? fromUrl.username ?? "guest";
    this.password = config?.password ?? process.env.TINA4_RABBITMQ_PASSWORD ?? fromUrl.password ?? "guest";
    this.vhost = config?.vhost ?? process.env.TINA4_RABBITMQ_VHOST ?? fromUrl.vhost ?? "/";
  }

  /**
   * Resolved connection config — exposed for testing/introspection.
   */
  getConfig(): Required<Omit<RabbitMQConfig, "visibilityTimeout">> {
    return {
      host: this.host,
      port: this.port,
      username: this.username,
      password: this.password,
      vhost: this.vhost,
    };
  }

  /**
   * Execute an AMQP operation synchronously via a child process.
   */
  private execSync(operation: string, queue: string, data?: string): string {
    // execFileSync imported at top level

    const script = `
      const net = require("node:net");
      const host = ${JSON.stringify(this.host)};
      const port = ${this.port};
      const username = ${JSON.stringify(this.username)};
      const password = ${JSON.stringify(this.password)};
      const vhost = ${JSON.stringify(this.vhost)};
      const operation = ${JSON.stringify(operation)};
      const queueName = ${JSON.stringify(queue)};
      const data = ${JSON.stringify(data ?? "")};

      // Simplified AMQP interaction — connect, perform operation, disconnect
      const sock = net.createConnection({ host, port }, () => {
        // Send protocol header
        sock.write(Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]));
      });

      let buffer = Buffer.alloc(0);
      let step = "handshake";
      let deliveryTag = null;
      let expectedBody = 0;
      let receivedBody = 0;

      sock.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        processFrames();
      });

      function processFrames() {
        while (buffer.length >= 7) {
          const frameType = buffer.readUInt8(0);
          const channel = buffer.readUInt16BE(1);
          const size = buffer.readUInt32BE(3);

          if (buffer.length < 7 + size + 1) return; // Incomplete frame

          const payload = buffer.subarray(7, 7 + size);
          buffer = buffer.subarray(7 + size + 1);

          if (frameType === 1) { // METHOD frame
            const classId = payload.readUInt16BE(0);
            const methodId = payload.readUInt16BE(2);
            handleMethod(classId, methodId, payload.subarray(4), channel);
          } else if (frameType === 2) { // HEADER frame
            // Content header — capture the declared body size so we know when the
            // body is complete (a body may arrive in several frames).
            if (operation === "get") {
              // body-size is a 64-bit field at offset 4 of the header payload;
              // the low 32 bits are enough for our JSON payloads.
              expectedBody = payload.readUInt32BE(8);
              receivedBody = 0;
            }
          } else if (frameType === 3) { // BODY frame
            // Content body
            const body = payload.toString("utf-8");
            process.stdout.write(body);
            if (operation === "get") {
              receivedBody += payload.length;
              // Once the whole body has arrived, cleanly close the connection so
              // the child exits 0 with the body on stdout. Without this the get
              // handler fell through to the 10s watchdog (exit 1), so pop()
              // always saw a failed child and returned null even though the
              // message body had been written to stdout.
              if (receivedBody >= expectedBody) {
                closeConnection();
              }
            }
          }
        }
      }

      function handleMethod(classId, methodId, args, channel) {
        if (classId === 10 && methodId === 10) {
          // Connection.Start → send Connection.Start-Ok
          const props = buildTable({ product: "Tina4", version: "1.0" });
          const mechanism = "PLAIN";
          const saslData = "\\x00" + username + "\\x00" + password;
          const locale = "en_US";

          const payload = Buffer.alloc(4096);
          let offset = 0;

          // Client properties (table)
          props.copy(payload, offset);
          offset += props.length;

          // Mechanism (short string)
          const mechBuf = Buffer.from(mechanism, "utf-8");
          payload.writeUInt8(mechBuf.length, offset); offset++;
          mechBuf.copy(payload, offset); offset += mechBuf.length;

          // Response (long string — SASL PLAIN)
          const saslBuf = Buffer.from(saslData, "utf-8");
          // Fix null bytes for PLAIN auth
          saslBuf[0] = 0;
          const userLen = Buffer.byteLength(username);
          saslBuf[1 + userLen] = 0;
          payload.writeUInt32BE(saslBuf.length, offset); offset += 4;
          saslBuf.copy(payload, offset); offset += saslBuf.length;

          // Locale (short string)
          const localeBuf = Buffer.from(locale, "utf-8");
          payload.writeUInt8(localeBuf.length, offset); offset++;
          localeBuf.copy(payload, offset); offset += localeBuf.length;

          sendMethod(0, 10, 11, payload.subarray(0, offset));
        }
        else if (classId === 10 && methodId === 30) {
          // Connection.Tune → send Connection.Tune-Ok + Connection.Open.
          // AMQP 0-9-1 requires TuneOk values to NOT exceed the server's proposal.
          // The broker's Tune args are channel-max:short, frame-max:long,
          // heartbeat:short. Hardcoding channel-max=0 means "no limit", which
          // RabbitMQ treats as exceeding its proposed channel-max (e.g. 2047) and
          // it aborts the connection right after Open — so negotiate instead.
          const desiredFrameMax = 131072;
          const desiredHeartbeat = 60;
          const serverChannelMax = args.length >= 2 ? args.readUInt16BE(0) : 0;
          const serverFrameMax = args.length >= 6 ? args.readUInt32BE(2) : 0;
          const serverHeartbeat = args.length >= 8 ? args.readUInt16BE(6) : 0;

          // channel-max: echo the server's value (its cap); 0 = unlimited.
          const channelMax = serverChannelMax;
          // frame-max: min(desired, server), treating 0 as unlimited on either side.
          const frameMax = serverFrameMax === 0 ? desiredFrameMax : Math.min(desiredFrameMax, serverFrameMax);
          // heartbeat: our choice, clamped to the server's if it proposed a non-zero one.
          const heartbeat = serverHeartbeat === 0 ? desiredHeartbeat : Math.min(desiredHeartbeat, serverHeartbeat);

          const tuneOk = Buffer.alloc(8);
          tuneOk.writeUInt16BE(channelMax, 0); // channel-max (negotiated)
          tuneOk.writeUInt32BE(frameMax, 2);   // frame-max (negotiated)
          tuneOk.writeUInt16BE(heartbeat, 6);  // heartbeat (negotiated)
          sendMethod(0, 10, 31, tuneOk);

          // Connection.Open
          const vhostBuf = Buffer.from(vhost, "utf-8");
          const openPayload = Buffer.alloc(3 + vhostBuf.length);
          openPayload.writeUInt8(vhostBuf.length, 0);
          vhostBuf.copy(openPayload, 1);
          openPayload.writeUInt8(0, 1 + vhostBuf.length); // reserved
          openPayload.writeUInt8(0, 2 + vhostBuf.length); // reserved
          sendMethod(0, 10, 40, openPayload);
        }
        else if (classId === 10 && methodId === 41) {
          // Connection.Open-Ok → open channel
          const chanOpen = Buffer.alloc(1);
          chanOpen.writeUInt8(0, 0);
          sendMethod(1, 20, 10, chanOpen);
        }
        else if (classId === 20 && methodId === 11) {
          // Channel.Open-Ok → declare queue
          // Payload: reserved(2) + queue short-string(1 + len) + flags(1) +
          // arguments empty-table(4) = 8 + len bytes. (Was 7 + len, which
          // overflowed the 4-byte empty-table write at offset 4 + len and threw
          // ERR_OUT_OF_RANGE — swallowed by the catch, so publish/get/size all
          // silently failed even once the handshake succeeded.)
          const qBuf = Buffer.from(queueName, "utf-8");
          const declPayload = Buffer.alloc(8 + qBuf.length);
          declPayload.writeUInt16BE(0, 0); // reserved
          declPayload.writeUInt8(qBuf.length, 2);
          qBuf.copy(declPayload, 3);
          declPayload.writeUInt8(2, 3 + qBuf.length); // durable=true
          declPayload.writeUInt32BE(0, 4 + qBuf.length); // arguments (empty table)
          sendMethod(1, 50, 10, declPayload);
        }
        else if (classId === 50 && methodId === 11) {
          // Queue.Declare-Ok → perform operation
          if (operation === "publish") {
            // Basic.Publish
            const qBuf = Buffer.from(queueName, "utf-8");
            const pubPayload = Buffer.alloc(5 + qBuf.length);
            pubPayload.writeUInt16BE(0, 0); // reserved
            pubPayload.writeUInt8(0, 2); // exchange (empty = default)
            pubPayload.writeUInt8(qBuf.length, 3);
            qBuf.copy(pubPayload, 4);
            pubPayload.writeUInt8(0, 4 + qBuf.length); // mandatory=false

            sendMethod(1, 60, 40, pubPayload);

            // Content header frame. AMQP 0-9-1 content header body is:
            // class-id(2) + weight(2) + body-size(8) + property-flags(2), then
            // one entry per set property flag. With property-flags = 0 (no
            // properties) the header is EXACTLY 14 bytes. The previous code
            // allocated 14 + 1 + ct.length + 1 = 32 bytes but only wrote the
            // first 14, leaving 18 trailing zero bytes that the broker parsed as
            // bogus property data — it replied INTERNAL_ERROR (541) and closed
            // the connection, so no message was ever stored. Allocate exactly 14.
            const bodyBuf = Buffer.from(data, "utf-8");
            const fullHeader = Buffer.alloc(14);
            fullHeader.writeUInt16BE(60, 0);          // class = basic
            fullHeader.writeUInt16BE(0, 2);           // weight
            fullHeader.writeUInt32BE(0, 4);           // body-size high 32 bits
            fullHeader.writeUInt32BE(bodyBuf.length, 8); // body-size low 32 bits
            fullHeader.writeUInt16BE(0x0000, 12);     // property flags: none set

            // Send header frame
            const hFrame = Buffer.alloc(7 + fullHeader.length + 1);
            hFrame.writeUInt8(2, 0); // header frame
            hFrame.writeUInt16BE(1, 1); // channel
            hFrame.writeUInt32BE(fullHeader.length, 3);
            fullHeader.copy(hFrame, 7);
            hFrame.writeUInt8(0xce, 7 + fullHeader.length);
            sock.write(hFrame);

            // Send body frame
            const bFrame = Buffer.alloc(7 + bodyBuf.length + 1);
            bFrame.writeUInt8(3, 0); // body frame
            bFrame.writeUInt16BE(1, 1); // channel
            bFrame.writeUInt32BE(bodyBuf.length, 3);
            bodyBuf.copy(bFrame, 7);
            bFrame.writeUInt8(0xce, 7 + bodyBuf.length);
            sock.write(bFrame);

            process.stdout.write("__PUBLISHED__");
            closeConnection();
          }
          else if (operation === "get") {
            // Basic.Get
            const qBuf = Buffer.from(queueName, "utf-8");
            const getPayload = Buffer.alloc(4 + qBuf.length);
            getPayload.writeUInt16BE(0, 0); // reserved
            getPayload.writeUInt8(qBuf.length, 2);
            qBuf.copy(getPayload, 3);
            getPayload.writeUInt8(1, 3 + qBuf.length); // no-ack=true
            sendMethod(1, 60, 70, getPayload);
          }
          else if (operation === "size") {
            // Queue.Declare-Ok already has message count
            const msgCount = args.readUInt32BE(args.readUInt8(0) + 1);
            process.stdout.write(String(msgCount));
            closeConnection();
          }
          else if (operation === "purge") {
            // Queue.Purge
            const qBuf = Buffer.from(queueName, "utf-8");
            const purgePayload = Buffer.alloc(4 + qBuf.length);
            purgePayload.writeUInt16BE(0, 0);
            purgePayload.writeUInt8(qBuf.length, 2);
            qBuf.copy(purgePayload, 3);
            purgePayload.writeUInt8(0, 3 + qBuf.length); // no-wait=false
            sendMethod(1, 50, 30, purgePayload);
          }
        }
        else if (classId === 60 && methodId === 71) {
          // Basic.Get-Ok — message body will follow in content frames
          // Body comes next via BODY frames handled above
        }
        else if (classId === 60 && methodId === 72) {
          // Basic.Get-Empty
          process.stdout.write("__EMPTY__");
          closeConnection();
        }
        else if (classId === 50 && methodId === 31) {
          // Queue.Purge-Ok
          process.stdout.write("__PURGED__");
          closeConnection();
        }
        else if (classId === 10 && methodId === 50) {
          // Connection.Close (server-initiated, e.g. a channel/protocol error)
          // → send Connection.Close-Ok and exit non-zero so the caller sees the
          // failure rather than a half-completed operation.
          sendMethod(0, 10, 51, Buffer.alloc(0));
          sock.destroy();
          process.exit(1);
        }
        else if (classId === 10 && methodId === 51) {
          // Connection.Close-Ok — the broker has acknowledged our Close, which
          // means it has fully processed everything we sent (incl. a Basic.Publish
          // and its content frames). Only now is it safe to drop the socket. The
          // previous code destroyed the socket on a blind 200ms timer right after
          // writing the body frame, racing the broker and dropping the message.
          sock.destroy();
          process.exit(0);
        }
      }

      function sendMethod(channel, classId, methodId, payload) {
        const mp = Buffer.alloc(4 + payload.length);
        mp.writeUInt16BE(classId, 0);
        mp.writeUInt16BE(methodId, 2);
        payload.copy(mp, 4);

        const frame = Buffer.alloc(7 + mp.length + 1);
        frame.writeUInt8(1, 0);
        frame.writeUInt16BE(channel, 1);
        frame.writeUInt32BE(mp.length, 3);
        mp.copy(frame, 7);
        frame.writeUInt8(0xce, 7 + mp.length);
        sock.write(frame);
      }

      function buildTable(obj) {
        const parts = [];
        for (const [k, v] of Object.entries(obj)) {
          const keyBuf = Buffer.alloc(1 + Buffer.byteLength(k));
          keyBuf.writeUInt8(Buffer.byteLength(k), 0);
          keyBuf.write(k, 1, "utf-8");
          parts.push(keyBuf);
          const valBuf = Buffer.alloc(5 + Buffer.byteLength(v));
          valBuf.writeUInt8(83, 0); // 'S'
          valBuf.writeUInt32BE(Buffer.byteLength(v), 1);
          valBuf.write(v, 5, "utf-8");
          parts.push(valBuf);
        }
        const tableData = Buffer.concat(parts);
        const result = Buffer.alloc(4 + tableData.length);
        result.writeUInt32BE(tableData.length, 0);
        tableData.copy(result, 4);
        return result;
      }

      function closeConnection() {
        // Send Connection.Close — payload is reply-code(2) + reply-text
        // short-string(1 + 0) + class-id(2) + method-id(2) = 7 bytes. (Was
        // Buffer.alloc(6), so the method-id write at offset 5 overflowed and
        // threw ERR_OUT_OF_RANGE right after "__PUBLISHED__" was written —
        // swallowed by the parent catch, so push() reported "publish failed"
        // even though the message had already reached the broker.)
        const closePayload = Buffer.alloc(7);
        closePayload.writeUInt16BE(200, 0); // reply code
        closePayload.writeUInt8(0, 2); // reply text (empty short-string)
        closePayload.writeUInt16BE(0, 3); // class
        closePayload.writeUInt16BE(0, 5); // method
        sendMethod(0, 10, 50, closePayload);
        // Do NOT destroy the socket here — wait for the broker's
        // Connection.Close-Ok (10/51), which confirms it has fully processed
        // everything we sent (the Basic.Publish + content frames in particular).
        // The 10/51 handler exits 0. This safety net only fires if the broker
        // never replies, and still exits 0 because stdout already carries the
        // operation's result (the message was flushed to the socket before
        // Close was sent).
        setTimeout(() => { sock.destroy(); process.exit(0); }, 3000).unref();
      }

      sock.on("error", (err) => {
        process.stderr.write(err.message);
        process.exit(1);
      });

      // Watchdog: only fires if an operation never completes (handshake hangs).
      // unref() so a completed operation's pending timer can't keep the event
      // loop alive and delay/override the clean exit above.
      setTimeout(() => { sock.destroy(); process.exit(1); }, 10000).unref();
    `;

    try {
      const result = execFileSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return result;
    } catch {
      return "";
    }
  }

  push(queue: string, payload: unknown, _delay?: number): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job = {
      id,
      payload,
      status: "pending",
      createdAt: now,
      attempts: 0,
      delayUntil: null,
    };

    const result = this.execSync("publish", queue, JSON.stringify(job));
    if (!result.includes("__PUBLISHED__")) {
      throw new Error("RabbitMQ publish failed");
    }
    return id;
  }

  pop(queue: string): QueueJob | null {
    const result = this.execSync("get", queue);
    if (!result || result === "__EMPTY__") return null;

    try {
      return JSON.parse(result) as QueueJob;
    } catch {
      return null;
    }
  }

  size(queue: string): number {
    const result = this.execSync("size", queue);
    const num = parseInt(result, 10);
    return isNaN(num) ? 0 : num;
  }

  clear(queue: string): void {
    this.execSync("purge", queue);
  }
}
