/**
 * Zero-dependency MQTT 3.1.1 client — the protocol every broker and every IoT
 * device already speaks.
 *
 * Built on Node's `node:net` and `node:tls` stdlib modules only: no npm package,
 * so an app that talks to Mosquitto / EMQX / HiveMQ / AWS IoT adds nothing to its
 * dependency tree. Shaped like the Queue on purpose — publish / subscribe /
 * consume:
 *
 *     import { Mqtt } from "@tina4stack/tina4-node";
 *
 *     const mqtt = new Mqtt({ url: "mqtt://broker:1883" });   // TINA4_MQTT_URL
 *     await mqtt.connect();
 *     await mqtt.publish("fleet/meter-42/telemetry", '{"kwh":12.5}', 1);
 *
 *     for await (const message of mqtt.consume("fleet/+/telemetry", 1)) {
 *       if (message.isDuplicate()) continue;                  // QoS 1 is at-least-once
 *       store(message.topic, message.payload);
 *     }
 *
 * Environment: TINA4_MQTT_URL (default mqtt://127.0.0.1:1883),
 * TINA4_MQTT_CLIENT_ID, TINA4_MQTT_KEEPALIVE (seconds, default 60),
 * TINA4_MQTT_CA_FILE, TINA4_MQTT_TLS_VERIFY.
 *
 * Node has no synchronous blocking socket read, so connect()/publish()/
 * subscribe()/receive() are async and consume() is an async generator — the same
 * idiom as the Queue. No background task runs by default; opt in to the
 * cooperative keepalive with startKeepalive(), which registers a background()
 * task exactly like the queue consumers do.
 *
 * Single reader: like every MQTT client the socket has ONE network reader. Call
 * receive()/consume() from one place.
 */

import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Env } from "./env.js";
import { Log } from "./logger.js";
import { background } from "./background.js";
import { MqttMessage } from "./mqttMessage.js";

/** Any MQTT protocol / connection failure. */
export class MqttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MqttError";
  }
}

/** The broker did not answer inside the timeout. */
export class MqttTimeoutError extends MqttError {
  constructor(message: string) {
    super(message);
    this.name = "MqttTimeoutError";
  }
}

export interface MqttOptions {
  url?: string;
  clientId?: string;
  username?: string;
  password?: string;
  caFile?: string;
  tlsVerify?: boolean;
  keepalive?: number;
  cleanSession?: boolean;
  willTopic?: string;
  willPayload?: unknown;
  willQos?: number;
  willRetain?: boolean;
  /** Seconds to wait for a control-packet answer (CONNACK / PUBACK / SUBACK). */
  timeout?: number;
  /** Seconds to wait for an application message; null/undefined blocks. */
  readTimeout?: number | null;
}

export interface ParsedMqttUrl {
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  password: string | null;
}

// Control packet types. The low nibble of SUBSCRIBE is 0x2 because MQTT 3.1.1
// mandates QoS 1 on that packet.
const CONNECT = 0x10;
const CONNACK = 0x20;
const PUBLISH = 0x30;
const PUBACK = 0x40;
const SUBSCRIBE = 0x82;
const SUBACK = 0x90;
const PINGREQ = 0xc0;
const PINGRESP = 0xd0;
const DISCONNECT = 0xe0;

const PROTOCOL_LEVEL = 0x04; // 4 == MQTT 3.1.1
const DEFAULT_PORT = 1883;
const DEFAULT_TLS_PORT = 8883;
const DEFAULT_URL = "mqtt://127.0.0.1:1883";
const DEFAULT_KEEPALIVE = 60;
const SUBSCRIPTION_REFUSED = 0x80;
const MAX_REMAINING_LENGTH = 268_435_455; // 4 varint bytes

// QoS 2 is refused, never silently downgraded. A caller who asked for
// exactly-once and quietly got at-least-once would double-process every
// duplicate forever without ever seeing an error.
const QOS2_REFUSED_MESSAGE =
  "MQTT QoS 2 (exactly-once delivery) is not supported by Tina4 -- this " +
  "client speaks QoS 0 and QoS 1 only, and refuses QoS 2 rather than " +
  "silently downgrading it to QoS 1. Use QoS 1 with an idempotent consumer " +
  "keyed on (device_id, device_timestamp): duplicates are then harmless, " +
  "which is what exactly-once was for.";

const CONNACK_RETURN_CODES: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "client identifier rejected",
  3: "server unavailable",
  4: "bad user name or password",
  5: "not authorised",
};

type Waiter = {
  need: number;
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export class Mqtt {
  public readonly host: string;
  public readonly port: number;
  public readonly clientId: string;
  public readonly keepalive: number;
  public readonly cleanSession: boolean;
  public readonly username: string | null;

  private readonly secure: boolean;
  private readonly password: string | null;
  private readonly caFile: string | null;
  private readonly tlsVerify: boolean;
  private readonly willTopic: string | null;
  private readonly willPayload: unknown;
  private readonly willQos: number;
  private readonly willRetain: boolean;
  private readonly timeout: number;
  private readonly readTimeout: number | null;

  private packetId = 0;
  private inbox: MqttMessage[] = [];
  private lastWriteAt = 0;
  private socket: net.Socket | tls.TLSSocket | null = null;
  private keepaliveTask: { stop: () => void } | null = null;
  private readBuffer: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private socketError: Error | null = null;

  constructor(options: MqttOptions = {}) {
    const parsed = Mqtt.parseUrl(options.url ?? (Env.str("TINA4_MQTT_URL") || DEFAULT_URL));
    this.host = parsed.host;
    this.port = parsed.port;
    this.secure = parsed.tls;

    // Explicit options win over the url's userinfo: the more specific source.
    this.username = options.username ?? parsed.username;
    let pw = options.password ?? parsed.password;
    if (pw === "") pw = null;
    this.password = pw;
    if (this.password !== null && (this.username === null || this.username === "")) {
      throw new Error(
        "MQTT password without a username is not allowed by MQTT 3.1.1 -- " +
          "supply both (mqtt://user:pass@host, or username/password) or neither",
      );
    }

    this.caFile = options.caFile ?? (Env.str("TINA4_MQTT_CA_FILE") || null);
    this.tlsVerify = options.tlsVerify ?? Env.bool("TINA4_MQTT_TLS_VERIFY", true);

    let cid = options.clientId ?? (Env.str("TINA4_MQTT_CLIENT_ID") || null);
    if (cid === null || cid === "") cid = "tina4-" + randomBytes(8).toString("hex");
    this.clientId = cid;

    this.keepalive = options.keepalive ?? Env.int("TINA4_MQTT_KEEPALIVE", DEFAULT_KEEPALIVE);
    this.cleanSession = options.cleanSession ?? true;
    this.willTopic = options.willTopic ?? null;
    this.willPayload = options.willPayload ?? null;
    this.willQos = options.willQos ?? 0;
    this.willRetain = options.willRetain ?? false;
    this.timeout = options.timeout ?? 5;
    this.readTimeout = options.readTimeout ?? null;

    if (this.willTopic !== null) this.refuseUnsupportedQos(this.willQos);
  }

  // -- url parsing --------------------------------------------------------

  /**
   * Split an MQTT url into { host, port, tls, username, password }.
   *
   * "mqtt://host:port" and "tcp://host:port" are plain TCP (default port 1883);
   * "mqtts://host:port" is TLS (default 8883). A bare "host" or "host:port"
   * works too, and an IPv6 literal is bracketed ("mqtt://[::1]:1883").
   * Credentials ride in the userinfo and are percent-decoded, so a password
   * containing @ : or / survives.
   */
  static parseUrl(url: string): ParsedMqttUrl {
    const raw = (url ?? "").trim();
    if (raw === "") {
      throw new Error(`MQTT url is empty -- set TINA4_MQTT_URL (e.g. ${DEFAULT_URL})`);
    }

    let scheme: string | null = null;
    let rest = raw;
    const schemeMatch = raw.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\//);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      if (!["mqtt", "tcp", "mqtts"].includes(scheme)) {
        throw new Error(
          `unsupported MQTT url scheme '${scheme}' in '${raw}' -- this client speaks ` +
            "mqtt://, tcp:// or mqtts:// (TLS). WebSocket transports are not implemented.",
        );
      }
      rest = raw.slice(schemeMatch[0].length);
    }

    const tlsFlag = scheme === "mqtts";

    // Split on the LAST "@" so a password containing an un-encoded "@" still
    // leaves the host intact.
    let username: string | null = null;
    let password: string | null = null;
    const atPos = rest.lastIndexOf("@");
    if (atPos !== -1) {
      const userinfo = rest.slice(0, atPos);
      rest = rest.slice(atPos + 1);
      const colon = userinfo.indexOf(":");
      if (colon === -1) {
        username = Mqtt.percentDecode(userinfo);
      } else {
        username = Mqtt.percentDecode(userinfo.slice(0, colon));
        password = Mqtt.percentDecode(userinfo.slice(colon + 1));
      }
    }

    // host is a [bracketed ipv6] or a run without : or /
    const hostPort = rest.split("/", 1)[0];
    let host = hostPort;
    let portStr: string | null = null;
    if (hostPort.startsWith("[")) {
      const close = hostPort.indexOf("]");
      if (close === -1) throw new Error(`malformed MQTT url '${raw}' -- unclosed IPv6 bracket`);
      host = hostPort.slice(1, close);
      const after = hostPort.slice(close + 1);
      if (after.startsWith(":")) portStr = after.slice(1);
    } else {
      const colon = hostPort.indexOf(":");
      if (colon !== -1) {
        host = hostPort.slice(0, colon);
        portStr = hostPort.slice(colon + 1);
      }
    }

    if (host === "") throw new Error(`malformed MQTT url '${raw}' -- expected mqtt://host:port`);
    if (portStr !== null && portStr !== "" && !/^\d+$/.test(portStr)) {
      throw new Error(`malformed MQTT url '${raw}' -- port must be numeric`);
    }

    return {
      host,
      port: portStr !== null && portStr !== "" ? parseInt(portStr, 10) : tlsFlag ? DEFAULT_TLS_PORT : DEFAULT_PORT,
      tls: tlsFlag,
      username: username !== null && username !== "" ? username : null,
      password,
    };
  }

  /**
   * Decode %XX in url userinfo. NOT decodeURI-style "+"-to-space: a "+" in a
   * password must survive verbatim, and an invalid "%" is left as-is (never throws).
   */
  private static percentDecode(value: string): string {
    return value.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Remaining Length varint: 7 bits per byte, high bit means "another byte
   * follows". A single-byte assumption works for every packet under 128 bytes
   * and then fails, so this is exercised directly at 0 / 127 / 128 / 16383.
   */
  static encodeRemainingLength(value: number): Buffer {
    if (!Number.isInteger(value) || value < 0 || value > MAX_REMAINING_LENGTH) {
      throw new Error(`remaining length ${value} is outside 0..${MAX_REMAINING_LENGTH}`);
    }
    const out: number[] = [];
    let length = value;
    do {
      const byte = length & 0x7f;
      length = Math.floor(length / 128);
      out.push(length > 0 ? byte | 0x80 : byte);
    } while (length > 0);
    return Buffer.from(out);
  }

  // -- connection ---------------------------------------------------------

  /**
   * Open the socket and complete the CONNECT / CONNACK handshake. Also the
   * reconnect path: an existing socket is closed first, and a durable session
   * (cleanSession false) resumes with the same clientId. Returns this for
   * chaining (`const c = await new Mqtt(opts).connect()`).
   */
  async connect(): Promise<this> {
    this.closeSocket();

    if (this.secure && this.tlsVerify && this.caFile && !existsSync(this.caFile)) {
      throw new MqttError(
        `MQTT CA file not found: ${this.caFile} -- TINA4_MQTT_CA_FILE (or caFile) ` +
          "must point at the broker's CA certificate in PEM form",
      );
    }
    if (this.secure && !this.tlsVerify) {
      Log.warning(
        `MQTT TLS certificate verification is DISABLED for mqtts://${this.host}:${this.port} -- ` +
          "the connection is encrypted but the broker's identity is NOT verified, so a " +
          "man in the middle can read and rewrite this traffic. Set TINA4_MQTT_CA_FILE " +
          "(or caFile) to the broker's CA and drop TINA4_MQTT_TLS_VERIFY=false.",
      );
    }

    const socket = await this.openSocket();
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.onSocketGone(new MqttError(`MQTT socket error: ${err.message}`)));
    socket.on("close", () => this.onSocketGone(new MqttError("broker closed the connection")));
    this.socket = socket;
    this.inbox = [];
    this.readBuffer = Buffer.alloc(0);
    this.socketError = null;

    // Payload order is FIXED: client id, will topic, will message, username,
    // password. Emitting them in any other order shifts every field after it.
    const parts: Buffer[] = [
      Mqtt.mqttString("MQTT"),
      Buffer.from([PROTOCOL_LEVEL, this.connectFlags()]),
      Mqtt.uint16(this.keepalive),
      Mqtt.mqttString(this.clientId),
    ];
    if (this.willTopic !== null) {
      parts.push(Mqtt.mqttString(this.willTopic));
      const willBytes = Mqtt.payloadBytes(this.willPayload);
      parts.push(Mqtt.uint16(willBytes.length), willBytes);
    }
    if (this.username !== null) parts.push(Mqtt.mqttString(this.username));
    if (this.password !== null) parts.push(Mqtt.mqttString(this.password));
    await this.writePacket(CONNECT, Buffer.concat(parts));

    const [header, payload] = await this.readPacket(this.deadlineIn(this.timeout));
    if (header !== CONNACK || payload.length < 2) {
      throw new MqttError(`expected CONNACK, got 0x${header.toString(16).padStart(2, "0")}`);
    }
    const returnCode = payload[1];
    if (returnCode !== 0) {
      const reason = CONNACK_RETURN_CODES[returnCode] ?? "unknown return code";
      throw new MqttError(`broker refused the connection: ${reason} (CONNACK return code ${returnCode})`);
    }
    return this;
  }

  /** Whether a socket is currently open. */
  connected(): boolean {
    return this.socket !== null;
  }

  /** True when this connection runs over TLS (mqtts://). */
  tls(): boolean {
    return this.secure;
  }

  /**
   * The negotiated cipher suite name, or null on a plain connection. A real name
   * here is proof the TLS handshake actually completed.
   */
  cipher(): string | null {
    if (!this.secure || this.socket === null) return null;
    const info = (this.socket as tls.TLSSocket).getCipher?.();
    return info ? info.name : null;
  }

  /** The negotiated TLS protocol version ("TLSv1.3"), or null when plain. */
  tlsVersion(): string | null {
    if (!this.secure || this.socket === null) return null;
    return (this.socket as tls.TLSSocket).getProtocol?.() ?? null;
  }

  // -- publish / subscribe / receive -------------------------------------

  /**
   * Publish an application message. Resolves to the packet identifier for QoS 1
   * (the broker's PUBACK must carry it back) and null for QoS 0.
   *
   * retain=true tells the broker to keep this as the topic's last known value and
   * hand it to every FUTURE subscriber. Publishing an EMPTY payload with
   * retain=true clears a retained value.
   */
  async publish(topic: string, payload: unknown, qos = 0, retain = false): Promise<number | null> {
    this.refuseUnsupportedQos(qos);
    const payloadBytes = Mqtt.payloadBytes(payload);
    const topicField = Mqtt.mqttString(topic);
    // The packet identifier exists ONLY when QoS > 0.
    const packetId = qos > 0 ? this.nextPacketId() : null;

    const parts: Buffer[] = [topicField];
    if (packetId !== null) parts.push(Mqtt.uint16(packetId));
    parts.push(payloadBytes);
    await this.writePacket(PUBLISH | (qos << 1) | (retain ? 0x01 : 0x00), Buffer.concat(parts));

    if (qos === 1) await this.waitForAcknowledgement(PUBACK, packetId, "PUBACK");
    return packetId;
  }

  /**
   * Subscribe to a topic filter ("fleet/+/telemetry", "fleet/#"). Resolves to the
   * QoS the broker GRANTED, which can be lower than requested.
   *
   * A SUBACK carrying 0x80 is a REFUSAL, not a success -- treating any SUBACK as
   * success means sitting on a dead subscription receiving nothing, so it throws.
   */
  async subscribe(topicFilter: string, qos = 1): Promise<number> {
    this.refuseUnsupportedQos(qos);
    const packetId = this.nextPacketId();
    const body = Buffer.concat([Mqtt.uint16(packetId), Mqtt.mqttString(topicFilter), Buffer.from([qos])]);
    await this.writePacket(SUBSCRIBE, body);

    const payload = await this.waitForAcknowledgement(SUBACK, packetId, "SUBACK");
    if (payload.length < 3) throw new MqttError(`malformed SUBACK: no return code for '${topicFilter}'`);
    const granted = payload[2];
    if (granted === SUBSCRIPTION_REFUSED) {
      throw new MqttError(
        `broker refused the subscription to '${topicFilter}' (SUBACK return ` +
          "code 0x80) -- check the topic filter and the broker ACLs",
      );
    }
    return granted;
  }

  /**
   * Read the next application message.
   *
   * ack=true (the default) acknowledges a QoS 1 delivery immediately, which is
   * right for a synchronous read. Pass ack=false when the message must be stored
   * before the broker is allowed to forget it -- an unacknowledged QoS 1 message
   * is redelivered with DUP set. consume() does exactly that.
   */
  async receive(timeout?: number | null, ack = true): Promise<MqttMessage> {
    const message = this.inbox.shift() ?? (await this.readPublish(this.deadlineIn(timeout ?? this.readTimeout)));
    if (ack) await message.acknowledge();
    return message;
  }

  /**
   * Long-running consumer, mirroring Queue.consume().
   *
   *     for await (const message of mqtt.consume("fleet/+/telemetry", 1)) {
   *       store(message);
   *     }
   *
   * The message is acknowledged AFTER the loop body hands control back to the
   * generator (the next iteration), so a body that throws leaves the message
   * unacknowledged and the broker redelivers it with DUP set -- at-least-once,
   * the point of QoS 1. iterations > 0 stops after that many messages.
   */
  async *consume(
    topicFilter?: string | null,
    qos = 1,
    iterations = 0,
    timeout?: number | null,
  ): AsyncGenerator<MqttMessage> {
    if (topicFilter !== undefined && topicFilter !== null) await this.subscribe(topicFilter, qos);
    let consumed = 0;
    while (true) {
      const message = await this.receive(timeout, false);
      yield message;
      await message.acknowledge();
      consumed++;
      if (iterations > 0 && consumed >= iterations) break;
    }
  }

  /** PUBACK a QoS 1 delivery. Called by MqttMessage.acknowledge(). */
  async acknowledge(packetId: number): Promise<boolean> {
    await this.writePacket(PUBACK, Mqtt.uint16(packetId));
    return true;
  }

  // -- keepalive ----------------------------------------------------------

  /**
   * PINGREQ and wait for the PINGRESP. Use this when nothing else is reading the
   * socket; under a consume loop use startKeepalive() instead.
   */
  async ping(timeout?: number | null): Promise<boolean> {
    await this.sendKeepalive();
    const deadline = this.deadlineIn(timeout ?? this.timeout);
    while (true) {
      const [header, payload] = await this.readPacket(deadline);
      if (header === PINGRESP) return true;
      if (this.stashPublish(header, payload)) continue;
      throw new MqttError(`expected PINGRESP, got 0x${header.toString(16).padStart(2, "0")}`);
    }
  }

  /**
   * Write a PINGREQ without waiting for the answer. The PINGRESP is absorbed by
   * whatever is reading the socket (receive() skips it).
   */
  async sendKeepalive(): Promise<boolean> {
    await this.writePacket(PINGREQ, Buffer.alloc(0));
    return true;
  }

  /**
   * Opt in to the cooperative keepalive. Registers a background() task -- the
   * same mechanism the queue consumers use -- that sends a PINGREQ only when the
   * connection has gone quiet, so an actively publishing client costs no extra
   * packets.
   */
  startKeepalive(intervalSeconds?: number): { stop: () => void } {
    if (this.keepaliveTask !== null) return this.keepaliveTask;
    if (this.keepalive <= 0) throw new MqttError("keepalive is disabled (keepalive=0) -- nothing to schedule");
    const seconds = intervalSeconds ?? Math.max(this.keepalive / 2, 1);
    this.keepaliveTask = background(async () => {
      if (this.connected() && this.idleFor(seconds)) await this.sendKeepalive();
    }, seconds);
    return this.keepaliveTask;
  }

  /** Stop the cooperative keepalive registered by startKeepalive(). */
  stopKeepalive(): boolean {
    if (this.keepaliveTask === null) return false;
    this.keepaliveTask.stop();
    this.keepaliveTask = null;
    return true;
  }

  /**
   * Say goodbye properly: DISCONNECT then close. The broker discards the Last
   * Will on a graceful disconnect.
   */
  async disconnect(): Promise<boolean> {
    this.stopKeepalive();
    try {
      if (this.connected()) await this.writePacket(DISCONNECT, Buffer.alloc(0));
    } catch {
      // Already gone -- closing is still the right outcome.
    } finally {
      this.closeSocket();
    }
    return true;
  }

  /**
   * Drop the socket WITHOUT a DISCONNECT -- what a crashed or unplugged device
   * looks like to the broker, and therefore what fires the Last Will.
   */
  kill(): boolean {
    this.stopKeepalive();
    this.closeSocket();
    return true;
  }

  // -- internals ----------------------------------------------------------

  private connectFlags(): number {
    let flags = this.cleanSession ? 0x02 : 0x00;
    if (this.willTopic !== null) {
      // Will flag 0x04, will QoS at bits 3-4, will retain 0x20.
      flags |= 0x04 | (this.willQos << 3);
      if (this.willRetain) flags |= 0x20;
    }
    if (this.username !== null) flags |= 0x80;
    if (this.password !== null) flags |= 0x40;
    return flags;
  }

  /**
   * Open a connected socket, upgrading to TLS when mqtts://. Rejects with an
   * MqttError on a connect timeout or a TLS verification failure (the cert error
   * message is preserved so a rejected cert reports WHY). Each connection builds
   * its OWN tls options object, so a CA supplied for one client never leaks into
   * a later client.
   */
  private openSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() => {
          try {
            sock.destroy();
          } catch {
            /* ignore */
          }
          reject(new MqttError(`could not connect to MQTT broker at ${this.host}:${this.port}: timed out`));
        });
      }, this.timeout * 1000);

      let sock: net.Socket | tls.TLSSocket;
      if (this.secure) {
        const opts: tls.ConnectionOptions = {
          host: this.host,
          port: this.port,
          servername: this.host,
          rejectUnauthorized: this.tlsVerify,
        };
        if (this.tlsVerify && this.caFile) opts.ca = readFileSync(this.caFile);
        sock = tls.connect(opts, () => settle(() => resolve(sock)));
      } else {
        sock = net.createConnection({ host: this.host, port: this.port }, () => settle(() => resolve(sock)));
      }
      sock.once("error", (err: Error) => {
        settle(() => {
          const label = this.secure ? `MQTT TLS handshake with ${this.host}:${this.port} failed` : `could not connect to MQTT broker at ${this.host}:${this.port}`;
          reject(new MqttError(`${label}: ${err.message}`));
        });
      });
    });
  }

  private refuseUnsupportedQos(qos: number): void {
    if (qos === 2) throw new Error(QOS2_REFUSED_MESSAGE);
    if (qos !== 0 && qos !== 1) throw new Error(`qos must be 0 or 1 (got ${qos})`);
  }

  /** Encode an MQTT string: a 2-byte big-endian length followed by UTF-8 bytes. */
  private static mqttString(value: string): Buffer {
    const bytes = Buffer.from(value, "utf-8");
    if (bytes.length > 0xffff) throw new Error("MQTT string is longer than 65535 bytes");
    return Buffer.concat([Mqtt.uint16(bytes.length), bytes]);
  }

  private static uint16(value: number): Buffer {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(value & 0xffff, 0);
    return b;
  }

  private static payloadBytes(payload: unknown): Buffer {
    if (payload === null || payload === undefined) return Buffer.alloc(0);
    if (Buffer.isBuffer(payload)) return payload;
    if (typeof payload === "string") return Buffer.from(payload, "utf-8");
    return Buffer.from(String(payload), "utf-8");
  }

  /** The next packet identifier (1..65535; 0 is invalid). */
  private nextPacketId(): number {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  private writePacket(header: number, body: Buffer): Promise<void> {
    if (this.socket === null) return Promise.reject(new MqttError("not connected to an MQTT broker"));
    const packet = Buffer.concat([Buffer.from([header]), Mqtt.encodeRemainingLength(body.length), body]);
    return new Promise((resolve, reject) => {
      this.socket!.write(packet, (err) => {
        if (err) {
          reject(new MqttError(`MQTT write failed: ${err.message}`));
        } else {
          this.lastWriteAt = Date.now();
          resolve();
        }
      });
    });
  }

  /**
   * Read one control packet. The fixed header is read in exactly 1 + N bytes
   * (N <= 4 for the varint) so the next packet's header is never consumed by a
   * speculative over-read.
   */
  private async readPacket(deadline: number | null): Promise<[number, Buffer]> {
    const header = (await this.readExact(1, deadline))[0];
    let multiplier = 1;
    let length = 0;
    while (true) {
      const byte = (await this.readExact(1, deadline))[0];
      length += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) break;
      multiplier <<= 7;
      if (multiplier > 0x200000) throw new MqttError("malformed Remaining Length (more than 4 varint bytes)");
    }
    return [header, length === 0 ? Buffer.alloc(0) : await this.readExact(length, deadline)];
  }

  /**
   * Read exactly `need` bytes from the socket buffer, awaiting more data when
   * short. Only one read is ever outstanding (the protocol reads sequentially),
   * so a single waiter slot is enough. The 'data' handler feeds the buffer and
   * services the waiter; a deadline arms a timer that rejects with a timeout.
   */
  private readExact(need: number, deadline: number | null): Promise<Buffer> {
    if (this.readBuffer.length >= need) return Promise.resolve(this.take(need));
    if (this.socket === null) return Promise.reject(this.socketError ?? new MqttError("not connected to an MQTT broker"));
    if (this.socketError !== null) return Promise.reject(this.socketError);

    return new Promise<Buffer>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (deadline !== null) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          reject(new MqttTimeoutError("timed out waiting for the MQTT broker"));
          return;
        }
        timer = setTimeout(() => {
          if (this.waiter) {
            this.waiter = null;
            reject(new MqttTimeoutError("timed out waiting for the MQTT broker"));
          }
        }, remaining);
      }
      this.waiter = { need, resolve, reject, timer };
      this.serviceWaiter();
    });
  }

  private take(need: number): Buffer {
    const out = this.readBuffer.subarray(0, need);
    this.readBuffer = this.readBuffer.subarray(need);
    return Buffer.from(out);
  }

  private serviceWaiter(): void {
    const w = this.waiter;
    if (w === null || this.readBuffer.length < w.need) return;
    this.waiter = null;
    if (w.timer) clearTimeout(w.timer);
    w.resolve(this.take(w.need));
  }

  private onData(chunk: Buffer): void {
    this.readBuffer = this.readBuffer.length === 0 ? chunk : Buffer.concat([this.readBuffer, chunk]);
    this.serviceWaiter();
  }

  private onSocketGone(err: Error): void {
    if (this.socket === null) return; // already closed by us
    this.socketError = err;
    this.socket = null;
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      if (w.timer) clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** Read packets until the next PUBLISH, skipping keepalive PINGRESPs. */
  private async readPublish(deadline: number | null): Promise<MqttMessage> {
    while (true) {
      const [header, payload] = await this.readPacket(deadline);
      if (header === PINGRESP) continue;
      const message = this.parsePublish(header, payload);
      if (message !== null) return message;
      throw new MqttError(`expected PUBLISH, got 0x${header.toString(16).padStart(2, "0")}`);
    }
  }

  /**
   * Park a PUBLISH that arrives while we wait for a PUBACK/SUBACK/PINGRESP
   * (normal when the same connection both publishes and subscribes) so receive()
   * still delivers it, in order, instead of it being mistaken for the ack.
   */
  private stashPublish(header: number, payload: Buffer): boolean {
    const message = this.parsePublish(header, payload);
    if (message === null) return false;
    this.inbox.push(message);
    return true;
  }

  private parsePublish(header: number, payload: Buffer): MqttMessage | null {
    if ((header & 0xf0) !== PUBLISH) return null;
    const qos = (header & 0x06) >> 1;
    const topicLength = payload.readUInt16BE(0);
    let offset = 2 + topicLength;
    const topic = payload.toString("utf-8", 2, 2 + topicLength);
    let packetId: number | null = null;
    if (qos > 0) {
      packetId = payload.readUInt16BE(offset);
      offset += 2;
    }
    return new MqttMessage(
      topic,
      Buffer.from(payload.subarray(offset)),
      qos,
      (header & 0x01) === 0x01,
      (header & 0x08) === 0x08,
      packetId,
      this,
    );
  }

  /**
   * Wait for a specific acknowledgement, tolerating interleaved PUBLISH and
   * PINGRESP packets. A mismatched packet identifier is silent data loss if
   * ignored, so it throws.
   */
  private async waitForAcknowledgement(expectedHeader: number, packetId: number | null, name: string): Promise<Buffer> {
    const deadline = this.deadlineIn(this.timeout);
    while (true) {
      const [header, payload] = await this.readPacket(deadline);
      if (header === PINGRESP) continue;
      if (this.stashPublish(header, payload)) continue;
      if (header !== expectedHeader) {
        throw new MqttError(`expected ${name}, got 0x${header.toString(16).padStart(2, "0")}`);
      }
      const receivedId = payload.readUInt16BE(0);
      if (receivedId !== packetId) {
        throw new MqttError(
          `${name} packet identifier mismatch: broker acknowledged ${receivedId} but we sent ${packetId}`,
        );
      }
      return payload;
    }
  }

  private idleFor(seconds: number): boolean {
    return (Date.now() - this.lastWriteAt) / 1000 >= seconds;
  }

  private deadlineIn(seconds: number | null | undefined): number | null {
    return seconds !== null && seconds !== undefined ? Date.now() + seconds * 1000 : null;
  }

  private closeSocket(): void {
    const sock = this.socket;
    this.socket = null;
    if (sock !== null) {
      sock.removeAllListeners();
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
    const w = this.waiter;
    if (w !== null) {
      this.waiter = null;
      if (w.timer) clearTimeout(w.timer);
      w.reject(new MqttError("connection closed"));
    }
  }
}
