/**
 * Tina4 RabbitMQ Queue Backend — AMQP 0-9-1 via raw TCP, zero dependencies.
 *
 * Implements the same interface as the file-based queue but uses RabbitMQ
 * for message storage and delivery.
 *
 * Configure via environment variables:
 *   TINA4_RABBITMQ_HOST     (default: "localhost")
 *   TINA4_RABBITMQ_PORT     (default: 5672)
 *   TINA4_RABBITMQ_USERNAME (default: "guest")
 *   TINA4_RABBITMQ_PASSWORD (default: "guest")
 *   TINA4_RABBITMQ_VHOST    (default: "/")
 */
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { QueueJob } from "../queue.js";

// ── Types ────────────────────────────────────────────────────

export interface RabbitMQConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  vhost?: string;
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
    this.host = config?.host ?? process.env.TINA4_RABBITMQ_HOST ?? "localhost";
    this.port = config?.port
      ?? (process.env.TINA4_RABBITMQ_PORT ? parseInt(process.env.TINA4_RABBITMQ_PORT, 10) : 5672);
    this.username = config?.username ?? process.env.TINA4_RABBITMQ_USERNAME ?? "guest";
    this.password = config?.password ?? process.env.TINA4_RABBITMQ_PASSWORD ?? "guest";
    this.vhost = config?.vhost ?? process.env.TINA4_RABBITMQ_VHOST ?? "/";
  }

  /**
   * Execute an AMQP operation synchronously via a child process.
   */
  private execSync(operation: string, queue: string, data?: string): string {
    const { execFileSync } = require("node:child_process");

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
            // Content header — skip for basic.get
          } else if (frameType === 3) { // BODY frame
            // Content body
            const body = payload.toString("utf-8");
            process.stdout.write(body);
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
          // Connection.Tune → send Connection.Tune-Ok + Connection.Open
          const tuneOk = Buffer.alloc(12);
          tuneOk.writeUInt16BE(0, 0);     // channel-max
          tuneOk.writeUInt32BE(131072, 2); // frame-max
          tuneOk.writeUInt16BE(60, 6);     // heartbeat
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
          const qBuf = Buffer.from(queueName, "utf-8");
          const declPayload = Buffer.alloc(7 + qBuf.length);
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

            // Content header
            const bodyBuf = Buffer.from(data, "utf-8");
            const header = Buffer.alloc(18);
            header.writeUInt16BE(60, 0); // class = basic
            header.writeUInt16BE(0, 2);  // weight
            // body size (64-bit, we only use lower 32)
            header.writeUInt32BE(0, 4);
            header.writeUInt32BE(bodyBuf.length, 8);
            header.writeUInt16BE(0x6000, 12); // property flags: delivery-mode + content-type
            // content-type
            const ct = Buffer.from("application/json");
            header.writeUInt8(ct.length, 14);

            const fullHeader = Buffer.alloc(14 + 1 + ct.length + 1);
            fullHeader.writeUInt16BE(60, 0);
            fullHeader.writeUInt16BE(0, 2);
            fullHeader.writeUInt32BE(0, 4);
            fullHeader.writeUInt32BE(bodyBuf.length, 8);
            fullHeader.writeUInt16BE(0x0000, 12); // no properties for simplicity

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
          // Connection.Close → send Connection.Close-Ok
          sendMethod(0, 10, 51, Buffer.alloc(0));
          sock.destroy();
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
        // Send Connection.Close
        const closePayload = Buffer.alloc(6);
        closePayload.writeUInt16BE(200, 0); // reply code
        closePayload.writeUInt8(0, 2); // reply text (empty)
        closePayload.writeUInt16BE(0, 3); // class
        closePayload.writeUInt16BE(0, 5); // method
        sendMethod(0, 10, 50, closePayload);
        setTimeout(() => sock.destroy(), 500);
      }

      sock.on("error", (err) => {
        process.stderr.write(err.message);
        process.exit(1);
      });

      setTimeout(() => { sock.destroy(); process.exit(1); }, 10000);
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

    const job: QueueJob = {
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
