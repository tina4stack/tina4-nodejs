/**
 * Tina4 Messenger — SMTP email client using Node.js built-in modules only.
 *
 * Sends email via raw SMTP socket communication (net/tls).
 * No nodemailer, no external dependencies.
 *
 * Unified .env-driven configuration with constructor override.
 * Priority: constructor params > .env (TINA4_MAIL_* with SMTP_* fallback) > sensible defaults
 *
 *   // .env
 *   // TINA4_MAIL_HOST=smtp.gmail.com
 *   // TINA4_MAIL_PORT=587
 *   // TINA4_MAIL_USERNAME=user@gmail.com
 *   // TINA4_MAIL_PASSWORD=app-password
 *   // TINA4_MAIL_FROM=noreply@myapp.com
 *   // TINA4_MAIL_ENCRYPTION=tls
 *   // TINA4_MAIL_IMAP_HOST=imap.gmail.com
 *   // TINA4_MAIL_IMAP_PORT=993
 *
 *   import { Messenger } from "@tina4/core";
 *
 *   const mail = new Messenger();                                      // reads from .env
 *   const mail = new Messenger({ host: "smtp.office365.com", port: 587 }); // override
 *   await mail.send("user@test.com", "Welcome", "<h1>Hello!</h1>", true, "Hello!");
 */
import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { isTruthy } from "./dotenv.js";
import { DevMailbox } from "./devMailbox.js";
import { Log } from "./logger.js";

/**
 * TLS certificate validation defaults to SECURE (rejectUnauthorized: true).
 * Set TINA4_MAIL_TLS_INSECURE=true to disable validation for dev / self-signed
 * certificates ONLY — never in production. Previously this was hard-coded to
 * `rejectUnauthorized: false`, silently disabling certificate validation for
 * every TLS connection (a man-in-the-middle risk).
 */
function tlsRejectUnauthorized(): boolean {
  return !isTruthy(process.env.TINA4_MAIL_TLS_INSECURE);
}

/**
 * Parse TINA4_MAIL_REDIRECT_TO (MAIL-DEC-01): comma-separated addresses, each
 * trimmed, blanks dropped. Unset/empty -> [] (redirect off, no behaviour
 * change). Read fresh on every send() call — same style as shouldCapture()'s
 * TINA4_MAIL_CAPTURE read — so a changed env is honoured without restart.
 */
function parseMailRedirectList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

// ── Types ────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  message: string;
  /**
   * The real Message-ID on success, `null` on failure — but ALWAYS present, so a
   * caller reading `result.id` gets one shape from both branches (G6). It used to
   * be omitted on the failure path, handing back `undefined` there and a string on
   * success.
   */
  id: string | null;
}

/**
 * Raised when an IMAP read fails to connect, authenticate, or speak the
 * protocol (a `NO`/`BAD` tagged response, a refused/reset socket, a TLS or
 * DNS failure). Distinct from a SUCCESSFUL fetch that simply has no messages —
 * that still returns an empty result ([] / 0 / {}), NOT an error.
 *
 * inbox()/read()/unread()/search()/folders() LOG and then RAISE this on a
 * connection/protocol failure so a dead mailbox is never silently mistaken for
 * an empty one. send() is unchanged — it keeps returning { success, error }.
 */
export class MessengerConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessengerConnectionError";
  }
}

export interface EmailMessage {
  id: string;
  type: "inbox" | "outbox";
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to?: string;
  subject: string;
  body: string;
  /** Plain-text alternative. Carried on the dev path too, so the captured message
   *  is the message: a mailbox that shows you something other than what you wrote
   *  is worse than no mailbox. */
  text?: string;
  html: boolean;
  attachments: string[];
  date: string;
  read: boolean;
}

interface MessengerOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  fromAddress?: string;
  fromName?: string;
  encryption?: string;
  /** @deprecated Use encryption instead */
  useTls?: boolean;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPass?: string;
  /** IMAP transport security: "tls" (default), "starttls", or "none". */
  imapEncryption?: string;
}

export interface ImapMessage {
  uid: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  seen: boolean;
}

/**
 * An attachment from a read() message. `content` is the RAW DECODED BYTES of the
 * part (transfer-decoded from base64 / quoted-printable), the SAME convention as
 * req.files[x].content — raw bytes, not base64 — so an attachment is downloadable
 * as-is; `size` is that decoded byte length. Parity with Python's read()
 * attachment dict {filename, content_type, size, content}, in Node's idiomatic
 * camelCase (ADR-0008 / G5). #69 folded the bytes in HERE — there is no separate
 * carrier (Python retired its attachments_data in 3.13.96).
 */
export interface ImapAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ImapFullMessage {
  uid: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** ISO-8601, parsed from the Date header (parity with Python's _iso_date). */
  date: string;
  bodyText: string;
  bodyHtml: string;
  /** Attachments, each carrying its decoded bytes. Empty when the message has none (G5 / #69). */
  attachments: ImapAttachment[];
  headers: Record<string, string>;
}

interface SendOptions {
  to: string | string[];
  subject: string;
  body: string;
  html?: boolean;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  attachments?: string[];
  headers?: Record<string, string>;
}

type SmtpSocket = net.Socket | tls.TLSSocket;

interface MailRecipients {
  toList: string[];
  ccList: string[];
  bccList: string[];
  allRecipients: string[];
}

class SmtpCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpCommandError";
  }
}

// ── SMTP helpers ─────────────────────────────────────────────

/**
 * Read a single SMTP response line (or multiline continuation).
 * Returns the status code and full response text.
 */
function readResponse(socket: net.Socket | tls.TLSSocket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");

      // SMTP multiline: "250-..." continuation, "250 ..." final
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length < 3) continue;
        const code = parseInt(line.substring(0, 3), 10);
        // Final line has a space after the code
        if (line.length >= 4 && line[3] === " ") {
          socket.removeListener("data", onData);
          socket.removeListener("error", onError);
          resolve({ code, text: buffer.trim() });
          return;
        }
      }
    };

    const onError = (err: Error) => {
      socket.removeListener("data", onData);
      reject(err);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/**
 * Send a command and read the response.
 */
function sendCommand(
  socket: net.Socket | tls.TLSSocket,
  command: string,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    socket.write(command + "\r\n", "utf-8", (err) => {
      if (err) return reject(err);
      readResponse(socket).then(resolve, reject);
    });
  });
}

/**
 * Build an RFC 2822 MIME message.
 */
function buildMimeMessage(options: {
  from: string;
  fromName?: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  html: boolean;
  text?: string;
  replyTo?: string;
  attachments?: string[];
  headers?: Record<string, string>;
  messageId: string;
}): string {
  const boundary = `----=_Tina4_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const altBoundary = `----=_Tina4Alt_${Date.now()}_${Math.random().toString(36).substring(2)}`;
  const hasAttachments = options.attachments && options.attachments.length > 0;
  const hasTextAlt = options.text !== undefined && options.html;
  const lines: string[] = [];

  // Headers
  const fromHeader = options.fromName
    ? `"${options.fromName}" <${options.from}>`
    : options.from;
  lines.push(`From: ${fromHeader}`);
  lines.push(`To: ${options.to.join(", ")}`);
  if (options.cc.length > 0) {
    lines.push(`Cc: ${options.cc.join(", ")}`);
  }
  lines.push(`Subject: ${options.subject}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: <${options.messageId}>`);
  lines.push("MIME-Version: 1.0");

  if (options.replyTo) {
    lines.push(`Reply-To: ${options.replyTo}`);
  }

  // Custom headers
  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      lines.push(`${key}: ${value}`);
    }
  }

  if (hasAttachments) {
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push("");
    lines.push(`--${boundary}`);

    // Body part (with optional text alternative)
    if (hasTextAlt) {
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(options.text!);
      lines.push("");
      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(options.body);
      lines.push("");
      lines.push(`--${altBoundary}--`);
    } else {
      const contentType = options.html ? "text/html" : "text/plain";
      lines.push(`Content-Type: ${contentType}; charset=UTF-8`);
      lines.push("Content-Transfer-Encoding: 7bit");
      lines.push("");
      lines.push(options.body);
    }

    // Attachments
    for (const filePath of options.attachments!) {
      const fileName = basename(filePath);
      const fileData = readFileSync(filePath);
      const base64Data = fileData.toString("base64");

      lines.push("");
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: application/octet-stream; name="${fileName}"`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push(`Content-Disposition: attachment; filename="${fileName}"`);
      lines.push("");

      // Split base64 into 76-char lines per RFC 2045
      for (let i = 0; i < base64Data.length; i += 76) {
        lines.push(base64Data.substring(i, i + 76));
      }
    }

    lines.push("");
    lines.push(`--${boundary}--`);
  } else if (hasTextAlt) {
    // Text alternative without attachments
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    lines.push(`--${altBoundary}`);
    lines.push("Content-Type: text/plain; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(options.text!);
    lines.push("");
    lines.push(`--${altBoundary}`);
    lines.push("Content-Type: text/html; charset=UTF-8");
    lines.push("Content-Transfer-Encoding: 7bit");
    lines.push("");
    lines.push(options.body);
    lines.push("");
    lines.push(`--${altBoundary}--`);
  } else {
    // Simple message
    const contentType = options.html ? "text/html" : "text/plain";
    lines.push(`Content-Type: ${contentType}; charset=UTF-8`);
    lines.push("");
    lines.push(options.body);
  }

  return lines.join("\r\n");
}

// ── Messenger ────────────────────────────────────────────────

export class Messenger {
  private host: string;
  private port: number;
  private username: string;
  private password: string;
  private fromAddress: string;
  private fromName: string;
  private encryption: string;
  private useTls: boolean;
  /** Whether an SMTP host was actually configured (see the constructor). */
  private smtpConfigured: boolean = false;
  /** The local mailbox, present only when this messenger captures. */
  public devMailbox: DevMailbox | null = null;
  private imapHost: string;
  private imapPort: number;
  private imapUser: string;
  private imapPass: string;
  private imapEncryption: string;

  constructor(options?: MessengerOptions) {
    // Priority: constructor > TINA4_MAIL_* > sensible default.
    // Legacy SMTP_*/IMAP_* env vars were removed in v3.12 — boot guard rejects them.
    // Whether a host was actually CONFIGURED, which is not the same as this.host
    // being set: it falls back to "localhost", so it is never empty and cannot
    // answer "can this messenger send?". The capture gate needs that answer, so
    // record it here while the real inputs are still in scope.
    this.smtpConfigured = Boolean(options?.host ?? process.env.TINA4_MAIL_HOST);
    this.host = options?.host
      ?? process.env.TINA4_MAIL_HOST
      ?? "localhost";
    this.port = options?.port
      ?? parseInt(process.env.TINA4_MAIL_PORT ?? "587", 10);
    this.username = options?.username
      ?? process.env.TINA4_MAIL_USERNAME
      ?? "";
    this.password = options?.password
      ?? process.env.TINA4_MAIL_PASSWORD
      ?? "";
    this.fromAddress = options?.fromAddress
      ?? process.env.TINA4_MAIL_FROM
      ?? (this.username || "noreply@localhost");
    this.fromName = options?.fromName
      ?? process.env.TINA4_MAIL_FROM_NAME
      ?? "";

    // Encryption: constructor > .env > backward-compat useTls > default "tls"
    const envEncryption = options?.encryption
      ?? process.env.TINA4_MAIL_ENCRYPTION;
    if (envEncryption) {
      this.encryption = envEncryption.toLowerCase();
    } else if (options?.useTls !== undefined) {
      this.encryption = options.useTls ? "tls" : "none";
    } else {
      this.encryption = "tls";
    }
    this.useTls = ["tls", "starttls"].includes(this.encryption);

    this.imapHost = options?.imapHost
      ?? process.env.TINA4_MAIL_IMAP_HOST
      ?? "";
    this.imapPort = options?.imapPort
      ?? parseInt(process.env.TINA4_MAIL_IMAP_PORT ?? "993", 10);
    this.imapUser = options?.imapUser
      ?? process.env.TINA4_MAIL_IMAP_USERNAME
      ?? this.username;
    this.imapPass = options?.imapPass
      ?? process.env.TINA4_MAIL_IMAP_PASSWORD
      ?? this.password;

    // IMAP encryption — separate from SMTP encryption because IMAP almost
    // always uses port 993 + implicit TLS while SMTP toggles between 587
    // (STARTTLS) and 465 (implicit TLS). Default is "tls" to match
    // industry-standard IMAPS port 993 behaviour.
    this.imapEncryption = (options?.imapEncryption
      ?? process.env.TINA4_MAIL_IMAP_ENCRYPTION
      ?? "tls").toLowerCase();
  }

  /**
   * Read-only IMAP encryption mode for inspection / tests.
   * Returns one of "tls", "starttls", "none", "ssl".
   */
  getImapEncryption(): string {
    return this.imapEncryption;
  }

  /**
   * Send an email via SMTP.
   */
  /**
   * Should send() capture locally instead of talking to SMTP?
   *
   * Availability decides, not verbosity. With no SMTP host configured sending is
   * impossible, so simulate it into a folder rather than failing -- that is what
   * makes a laptop with no mail server usable. TINA4_MAIL_CAPTURE forces capture
   * even when a host IS configured.
   *
   * TINA4_DEBUG deliberately does NOT gate this, and neither does NODE_ENV. Debug
   * must still be able to send, and the old `NODE_ENV !== "production"` clause
   * silently swallowed every staging email.
   */
  private shouldCapture(): boolean {
    if (isTruthy(process.env.TINA4_MAIL_CAPTURE)) return true;
    return !this.smtpConfigured;
  }

  /** The local mailbox, created on first capture and reused after. */
  private getDevMailbox(): DevMailbox {
    if (this.devMailbox === null) {
      this.devMailbox = new DevMailbox();
    }
    return this.devMailbox;
  }

  private prepareRecipients(options: SendOptions, redirect = false): MailRecipients {
    let toList = Array.isArray(options.to) ? options.to : [options.to];
    let ccList = Array.isArray(options.cc) ? options.cc : (options.cc ? [options.cc] : []);
    let bccList = Array.isArray(options.bcc) ? options.bcc : (options.bcc ? [options.bcc] : []);
    let allRecipients = [...toList, ...ccList, ...bccList];
    const redirectTo = redirect ? parseMailRedirectList(process.env.TINA4_MAIL_REDIRECT_TO) : [];
    if (redirectTo.length > 0) {
      const originalTo = allRecipients.join(", ");
      toList = redirectTo;
      ccList = [];
      bccList = [];
      allRecipients = [...toList];
      options.headers = { ...(options.headers ?? {}), "X-Tina4-Original-To": originalTo };
    }
    return { toList, ccList, bccList, allRecipients };
  }

  private async connectSmtpSocket(): Promise<SmtpSocket> {
    if (this.port === 465) {
      const socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: tlsRejectUnauthorized() });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      return socket;
    }
    const socket = net.createConnection({ host: this.host, port: this.port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  private async requireSmtpResponse(socket: SmtpSocket, command: string, expected: number, failure: string): Promise<{ code: number; text: string }> {
    const response = command === "" ? await readResponse(socket) : await sendCommand(socket, command);
    if (response.code !== expected) throw new SmtpCommandError(`${failure}: ${response.text}`);
    return response;
  }

  private async openSmtpSession(): Promise<SmtpSocket> {
    let socket = await this.connectSmtpSocket();
    try {
      await this.requireSmtpResponse(socket, "", 220, "SMTP greeting failed");
      const ehlo = await this.requireSmtpResponse(socket, `EHLO ${this.host}`, 250, "EHLO failed");
      if (this.useTls && this.port !== 465 && ehlo.text.includes("STARTTLS")) {
        await this.requireSmtpResponse(socket, "STARTTLS", 220, "STARTTLS failed");
        const plainSocket = socket as net.Socket;
        const secureSocket = tls.connect({ socket: plainSocket, host: this.host, rejectUnauthorized: tlsRejectUnauthorized() });
        await new Promise<void>((resolve, reject) => {
          secureSocket.once("secureConnect", resolve);
          secureSocket.once("error", reject);
        });
        socket = secureSocket;
        await this.requireSmtpResponse(socket, `EHLO ${this.host}`, 250, "EHLO after STARTTLS failed");
      }
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  private async authenticateSmtp(socket: SmtpSocket): Promise<void> {
    if (!this.username || !this.password) return;
    await this.requireSmtpResponse(socket, "AUTH LOGIN", 334, "AUTH LOGIN failed");
    await this.requireSmtpResponse(socket, Buffer.from(this.username).toString("base64"), 334, "AUTH username failed");
    await this.requireSmtpResponse(socket, Buffer.from(this.password).toString("base64"), 235, "AUTH password failed");
  }

  private async sendSmtpEnvelope(socket: SmtpSocket, recipients: string[]): Promise<void> {
    await this.requireSmtpResponse(socket, `MAIL FROM:<${this.fromAddress}>`, 250, "MAIL FROM failed");
    for (const recipient of recipients) {
      const response = await sendCommand(socket, `RCPT TO:<${recipient}>`);
      if (response.code !== 250 && response.code !== 251) throw new SmtpCommandError(`RCPT TO <${recipient}> failed: ${response.text}`);
    }
  }

  private async sendSmtpMessage(socket: SmtpSocket, options: SendOptions, recipients: MailRecipients, messageId: string): Promise<void> {
    await this.requireSmtpResponse(socket, "DATA", 354, "DATA failed");
    const mimeMessage = buildMimeMessage({
      from: this.fromAddress,
      fromName: this.fromName,
      to: recipients.toList,
      cc: recipients.ccList,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      text: options.text,
      replyTo: options.replyTo,
      attachments: options.attachments,
      headers: options.headers,
      messageId,
    });
    await this.requireSmtpResponse(socket, mimeMessage + "\r\n.", 250, "Message delivery failed");
    await sendCommand(socket, "QUIT");
  }

  private async sendSmtp(options: SendOptions, recipients: MailRecipients, messageId: string): Promise<SendResult> {
    let socket: SmtpSocket | null = null;
    try {
      socket = await this.openSmtpSession();
      await this.authenticateSmtp(socket);
      await this.sendSmtpEnvelope(socket, recipients.allRecipients);
      await this.sendSmtpMessage(socket, options, recipients, messageId);
      socket.destroy();
      return { success: true, message: "Email sent successfully", id: messageId };
    } catch (err) {
      socket?.destroy();
      if (err instanceof SmtpCommandError) return { success: false, message: err.message, id: null };
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `SMTP error: ${errMsg}`, id: null };
    }
  }

  async send(
    to: string | string[],
    subject: string,
    body: string,
    html: boolean = false,
    text?: string,
    cc?: string | string[],
    bcc?: string | string[],
    replyTo?: string,
    attachments?: string[],
    headers?: Record<string, string>,
  ): Promise<SendResult> {
    const options: SendOptions = { to, subject, body, html, text, cc, bcc, replyTo, attachments, headers };
    const capturedRecipients = this.prepareRecipients(options);

    // Dev capture is a BRANCH here, not a different object returned by the factory.
    // createMessenger() used to hand back a DevMailbox, which has capture() and no
    // send(), so the documented call threw TypeError (nodejs#41).
    if (this.shouldCapture()) {
      return this.getDevMailbox().capture(
        to, subject, body, html, text, capturedRecipients.ccList, capturedRecipients.bccList, replyTo,
        attachments, this.fromAddress || undefined,
      );
    }
    const recipients = this.prepareRecipients(options, true);

    const messageId = `${randomUUID()}@${this.host}`;

    if (recipients.allRecipients.length === 0) {
      return { success: false, message: "No recipients specified", id: null };
    }

    if (!this.fromAddress) {
      return { success: false, message: "No from address configured", id: null };
    }

    return this.sendSmtp(options, recipients, messageId);
  }

  /**
   * Render a Frond template STRING and send it as an HTML email (G7, parity with
   * Python's send_template). Extra send() options (cc, bcc, replyTo, attachments,
   * headers) pass through. If the Frond package cannot be loaded the raw template
   * is sent verbatim (matches Python's ImportError fallback) rather than failing.
   */
  async sendTemplate(
    to: string | string[],
    subject: string,
    template: string,
    data: Record<string, unknown> = {},
    cc?: string | string[],
    bcc?: string | string[],
    replyTo?: string,
    attachments?: string[],
    headers?: Record<string, string>,
  ): Promise<SendResult> {
    let body = template;
    try {
      // Same sibling-package specifier server.ts uses for Frond (resolves in dev
      // under tsx and in the built dist). Core never hard-depends on Frond.
      const { Frond } = (await import("../../frond/src/engine.js")) as {
        Frond: new (dir?: string) => { renderString(t: string, d?: Record<string, unknown>): string };
      };
      body = new Frond().renderString(template, data);
    } catch {
      // Frond unavailable — send the template text as-is (Python parity).
    }
    return this.send(to, subject, body, true, undefined, cc, bcc, replyTo, attachments, headers);
  }

  /**
   * Test the SMTP connection without sending an email.
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      let socket: net.Socket | tls.TLSSocket;

      if (this.port === 465) {
        socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: tlsRejectUnauthorized() });
        await new Promise<void>((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.once("error", reject);
        });
      } else {
        socket = net.createConnection({ host: this.host, port: this.port });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
      }

      const greeting = await readResponse(socket);
      if (greeting.code !== 220) {
        socket.destroy();
        return { success: false, message: `SMTP greeting failed: ${greeting.text}` };
      }

      const ehlo = await sendCommand(socket, `EHLO ${this.host}`);
      if (ehlo.code !== 250) {
        socket.destroy();
        return { success: false, message: `EHLO failed: ${ehlo.text}` };
      }

      await sendCommand(socket, "QUIT");
      socket.destroy();

      return { success: true, message: `Connected to ${this.host}:${this.port}` };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Connection failed: ${errMsg}` };
    }
  }

  // ── IMAP (Read) ────────────────────────────────────────────

  /**
   * Connect to the IMAP server via raw TCP/TLS.
   * Returns the socket and reads the greeting.
   */
  private async imapConnect(): Promise<net.Socket | tls.TLSSocket> {
    if (!this.imapHost) {
      throw new Error("IMAP host not configured (set imapHost or IMAP_HOST env)");
    }

    let socket: net.Socket | tls.TLSSocket;

    // Honour TINA4_MAIL_IMAP_ENCRYPTION when set; otherwise infer from port.
    // "tls" / "ssl" → implicit TLS connect; anything else → plain connect.
    const useTls = this.imapEncryption === "tls" || this.imapEncryption === "ssl"
      || (this.imapEncryption === "" && this.imapPort === 993);

    if (useTls) {
      socket = tls.connect({ host: this.imapHost, port: this.imapPort, rejectUnauthorized: tlsRejectUnauthorized() });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
    } else {
      socket = net.createConnection({ host: this.imapHost, port: this.imapPort });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    }

    // Read server greeting
    await imapReadLine(socket);

    // Login
    if (this.imapUser && this.imapPass) {
      const loginResp = await imapCommand(socket, `LOGIN ${imapQuote(this.imapUser)} ${imapQuote(this.imapPass)}`);
      if (!loginResp.includes("OK")) {
        socket.destroy();
        throw new Error(`IMAP login failed: ${loginResp}`);
      }
    }

    return socket;
  }

  /**
   * Disconnect from IMAP cleanly.
   */
  private async imapDisconnect(socket: net.Socket | tls.TLSSocket): Promise<void> {
    try {
      await imapCommand(socket, "LOGOUT");
    } catch { /* ignore */ }
    socket.destroy();
  }

  /**
   * Fetch latest messages from a folder.
   * Returns list of message summaries.
   */
  async inbox(folder: string = "INBOX", limit: number = 20, offset: number = 0): Promise<ImapMessage[]> {
    let socket: net.Socket | tls.TLSSocket;
    try {
      socket = await this.imapConnect();
    } catch (err) {
      throw imapFail("inbox", err);
    }
    try {
      // Select folder
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);

      // Search for all messages
      const searchResp = await imapCommand(socket, "UID SEARCH ALL");
      const uids = parseSearchResponse(searchResp);
      if (uids.length === 0) return [];

      // Latest first
      uids.reverse();
      const selected = uids.slice(offset, offset + limit);
      if (selected.length === 0) return [];

      const messages: ImapMessage[] = [];
      for (const uid of selected) {
        // Fetch the WHOLE message (PEEK — never mark seen) so the snippet is
        // built from real, transfer-decoded body text (G3), not the empty string
        // a header-only fetch could ever produce.
        const fetchResp = await imapCommand(socket, `UID FETCH ${uid} (FLAGS BODY.PEEK[])`);
        messages.push(parseSummary(uid, fetchResp));
      }

      return messages;
    } catch (err) {
      throw imapFail("inbox", err);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Read a single message by its IMAP UID.
   */
  async read(uid: string, folder: string = "INBOX"): Promise<ImapFullMessage | null> {
    let socket: net.Socket | tls.TLSSocket;
    try {
      socket = await this.imapConnect();
    } catch (err) {
      throw imapFail("read", err);
    }
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const fetchResp = await imapCommand(socket, `UID FETCH ${uid} (FLAGS BODY[])`);

      // A genuinely missing UID is a tagged OK with no message body literal —
      // that is NOT an error, so it must not throw. It returns null: FALSY, so
      // `if (!msg)` detects it. This used to return emptyFullMessage(uid) under
      // a comment claiming "parity with Python's {}" -- but that object is
      // TRUTHY, while Python's {} , PHP's null and Ruby's nil are all falsy, so
      // Node was the one framework where a caller could not tell "no such
      // message" from a real one without inspecting individual fields.
      if (!/\{\d+\}/.test(fetchResp)) {
        return null;
      }

      // Mark as seen
      await imapCommand(socket, `UID STORE ${uid} +FLAGS (\\Seen)`);

      return parseFullMessage(uid, fetchResp);
    } catch (err) {
      throw imapFail("read", err);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Search messages using IMAP search criteria.
   */
  async search(
    folder: string = "INBOX",
    subject?: string,
    sender?: string,
    since?: string,
    before?: string,
    unseenOnly: boolean = false,
    limit: number = 50,
  ): Promise<ImapMessage[]> {
    // Build IMAP SEARCH criteria from structured params
    const criteria: string[] = ["ALL"];
    if (subject) criteria.push(`SUBJECT "${subject}"`);
    if (sender) criteria.push(`FROM "${sender}"`);
    if (since) criteria.push(`SINCE ${since}`);
    if (before) criteria.push(`BEFORE ${before}`);
    if (unseenOnly) criteria.push("UNSEEN");

    const query = criteria.join(" ");
    let socket: net.Socket | tls.TLSSocket;
    try {
      socket = await this.imapConnect();
    } catch (err) {
      throw imapFail("search", err);
    }
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const searchResp = await imapCommand(socket, `UID SEARCH ${query}`);
      const uids = parseSearchResponse(searchResp);
      if (uids.length === 0) return [];

      uids.reverse();
      const messages: ImapMessage[] = [];
      for (const uid of uids.slice(0, limit)) {
        const fetchResp = await imapCommand(socket, `UID FETCH ${uid} (FLAGS BODY.PEEK[])`);
        messages.push(parseSummary(uid, fetchResp));
      }
      return messages;
    } catch (err) {
      throw imapFail("search", err);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Delete a message by UID (mark \Deleted, then EXPUNGE).
   *
   * `delete` is the one cross-framework name (python/php/ruby/node all spell it
   * `delete`). `deleteMessage` remains as a DEPRECATED alias for one release.
   */
  async delete(uid: string, folder: string = "INBOX"): Promise<void> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      await imapCommand(socket, `UID STORE ${uid} +FLAGS (\\Deleted)`);
      await imapCommand(socket, "EXPUNGE");
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /** @deprecated Use {@link delete} — kept as an alias for one release (G7). */
  async deleteMessage(uid: string, folder: string = "INBOX"): Promise<void> {
    return this.delete(uid, folder);
  }

  /**
   * Mark a message as read (+FLAGS \Seen).
   */
  async markRead(uid: string, folder: string = "INBOX"): Promise<void> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      await imapCommand(socket, `UID STORE ${uid} +FLAGS (\\Seen)`);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Mark a message as unread (-FLAGS \Seen) — the inverse of markRead (G7,
   * parity with Python's mark_unread).
   */
  async markUnread(uid: string, folder: string = "INBOX"): Promise<void> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      await imapCommand(socket, `UID STORE ${uid} -FLAGS (\\Seen)`);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Count unseen messages in a folder.
   */
  async unread(folder: string = "INBOX"): Promise<number> {
    let socket: net.Socket | tls.TLSSocket;
    try {
      socket = await this.imapConnect();
    } catch (err) {
      throw imapFail("unread", err);
    }
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const searchResp = await imapCommand(socket, "UID SEARCH UNSEEN");
      return parseSearchResponse(searchResp).length;
    } catch (err) {
      throw imapFail("unread", err);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * List available IMAP folders/mailboxes.
   */
  async folders(): Promise<string[]> {
    let socket: net.Socket | tls.TLSSocket;
    try {
      socket = await this.imapConnect();
    } catch (err) {
      throw imapFail("folders", err);
    }
    try {
      const resp = await imapCommand(socket, 'LIST "" "*"');
      const result: string[] = [];
      for (const line of resp.split("\r\n")) {
        // Parse LIST response: * LIST (\flags) "/" "FolderName"
        const m = line.match(/\* LIST \([^)]*\) "[^"]*" "?([^"\r\n]+)"?/i);
        if (m) result.push(m[1]);
      }
      return result;
    } catch (err) {
      throw imapFail("folders", err);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Test IMAP connectivity without reading.
   */
  async testImapConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const socket = await this.imapConnect();
      await this.imapDisconnect(socket);
      return { success: true, message: `Connected to ${this.imapHost}:${this.imapPort}` };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `IMAP connection failed: ${errMsg}` };
    }
  }
}

// ── IMAP helpers (raw TCP protocol) ──────────────────────────

let imapTagCounter = 0;

function imapQuote(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function imapReadLine(socket: net.Socket | tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const nlIndex = buffer.indexOf("\r\n");
      if (nlIndex !== -1) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        resolve(buffer);
      }
    };

    const onError = (err: Error) => {
      socket.removeListener("data", onData);
      reject(err);
    };

    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function imapCommand(socket: net.Socket | tls.TLSSocket, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    imapTagCounter++;
    const tag = `T${imapTagCounter}`;
    const fullCommand = `${tag} ${command}\r\n`;

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      // Tagged OK = success.
      if (buffer.includes(`${tag} OK`)) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        resolve(buffer);
        return;
      }
      // Tagged NO / BAD = protocol failure — fail loud (mirrors Python's
      // non-OK status raise). A genuinely empty mailbox is a tagged OK with an
      // empty SEARCH result, which still resolves above.
      if (buffer.includes(`${tag} NO`) || buffer.includes(`${tag} BAD`)) {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
        reject(new MessengerConnectionError(`IMAP command failed: ${command.split(" ")[0]} → ${buffer.trim()}`));
      }
    };

    const onError = (err: Error) => {
      socket.removeListener("data", onData);
      reject(err);
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.write(fullCommand, "utf-8");
  });
}

/**
 * Log an IMAP connection/protocol failure and return the error to throw.
 * A genuinely empty mailbox is NOT an error and never reaches here.
 */
function imapFail(method: string, err: unknown): MessengerConnectionError {
  const e = err instanceof Error ? err : new Error(String(err));
  Log.error(`Messenger IMAP ${method}() failed: ${e.name}: ${e.message}`);
  if (e instanceof MessengerConnectionError) return e;
  return new MessengerConnectionError(`IMAP ${method} failed: ${e.message}`);
}

function parseSearchResponse(response: string): string[] {
  // SEARCH response: * SEARCH 1 2 3 4 5
  const match = response.match(/\* SEARCH (.+)/);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter((s) => /^\d+$/.test(s));
}

/**
 * The RFC822 message octets from a FETCH response. IMAP frames the body as a
 * `{N}` literal followed by exactly N octets, so slice N — that cleanly drops the
 * trailing `)\r\nTAG OK ...` the server appends after the literal (which the old
 * regex-then-strip path had to chase). For the ASCII bodies these methods see,
 * octet length equals string length; a response with no literal falls back to
 * itself.
 */
function extractRawMessage(response: string): string {
  const m = response.match(/\{(\d+)\}\r\n/);
  if (!m) return response;
  const start = (m.index ?? 0) + m[0].length;
  return response.slice(start, start + parseInt(m[1], 10));
}

/** Parse a header block into a lower-cased map, honouring folded continuations. */
function parseMimeHeaders(section: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let currentKey = "";
  for (const line of section.split(/\r\n/)) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const idx = line.indexOf(":");
      if (idx > 0) {
        currentKey = line.substring(0, idx).trim().toLowerCase();
        headers[currentKey] = line.substring(idx + 1).trim();
      }
    }
  }
  return headers;
}

/**
 * Transfer-decode a part body per its Content-Transfer-Encoding. base64 and
 * quoted-printable become readable text; 7bit/8bit/binary/absent pass through.
 * This is what turns the snippet from raw base64 into real words (G3).
 */
function decodeTransfer(body: string, encoding: string): string {
  const enc = encoding.toLowerCase().trim();
  if (enc === "base64") {
    try {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  if (enc === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "")                                       // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/**
 * Transfer-decode an attachment part body to its RAW BYTES (#69). base64 and
 * quoted-printable become the original octets; 7bit/8bit/binary/absent pass
 * through as their own bytes. This is the byte-level sibling of decodeTransfer()
 * (which returns text for the message bodies): an attachment must round-trip
 * byte-for-byte to be downloadable, so it returns a Buffer, never a string.
 * Mirrors Python's part.get_payload(decode=True).
 */
function decodeAttachmentBytes(body: string, encoding: string): Buffer {
  const enc = encoding.toLowerCase().trim();
  if (enc === "base64") {
    // The transport wraps base64 at 76 cols (RFC 2045); strip ALL whitespace so
    // the wrapped lines rejoin into exactly the original bytes.
    return Buffer.from(body.replace(/\s+/g, ""), "base64");
  }
  // RFC 2046: the CRLF immediately before the boundary delimiter belongs to the
  // boundary, not the part body — drop exactly that one trailing CRLF.
  const trimmed = body.replace(/\r\n$/, "");
  if (enc === "quoted-printable") {
    const collapsed = trimmed.replace(/=\r?\n/g, "");               // soft line breaks
    const bytes: number[] = [];
    for (let i = 0; i < collapsed.length; i++) {
      const hex = collapsed.substring(i + 1, i + 3);
      if (collapsed[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(collapsed.charCodeAt(i) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(trimmed, "utf-8");
}

/** filename="..." from Content-Disposition, else name="..." from Content-Type. */
function attachmentFilename(disposition: string, contentType: string): string {
  const d = disposition.match(/filename="?([^";\r\n]+)"?/i);
  if (d) return d[1].trim();
  const c = contentType.match(/name="?([^";\r\n]+)"?/i);
  if (c) return c[1].trim();
  return "attachment";
}

/**
 * A decoded, tag-stripped, whitespace-collapsed 200-char preview (G3). Prefers
 * the plain-text body, falls back to the HTML with its tags removed. The inputs
 * are already transfer-decoded, so this is real readable text — never the raw
 * base64 a header-only / undecoded fetch used to emit.
 */
function makeSnippet(bodyText: string, bodyHtml: string): string {
  return (bodyText || bodyHtml || "")
    .replace(/<[^>]+>/g, " ")     // strip HTML tags
    .replace(/\s+/g, " ")          // collapse whitespace
    .trim()
    .slice(0, 200);
}

/** The Date header as ISO-8601 (G4); the raw string if unparseable, "" if absent. */
function toIsoDate(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

interface ParsedMessage {
  headers: Record<string, string>;
  bodyText: string;
  bodyHtml: string;
  attachments: ImapAttachment[];
}

/**
 * Walk a FETCH response into headers + transfer-decoded bodies + attachment
 * metadata. Shared by parseSummary() (inbox/search) and parseFullMessage()
 * (read) so the snippet and the read() bodies can never drift.
 */
function parseMessage(response: string): ParsedMessage {
  const raw = extractRawMessage(response);
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headerSection = headerEnd >= 0 ? raw.substring(0, headerEnd) : raw;
  const bodySection = headerEnd >= 0 ? raw.substring(headerEnd + 4) : "";
  const headers = parseMimeHeaders(headerSection);
  const contentType = headers["content-type"] ?? "text/plain";

  let bodyText = "";
  let bodyHtml = "";
  const attachments: ImapAttachment[] = [];

  if (contentType.includes("multipart")) {
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    if (boundaryMatch) {
      const boundary = "--" + boundaryMatch[1];
      for (const part of bodySection.split(boundary)) {
        const trimmed = part.trim();
        if (trimmed === "" || trimmed === "--") continue;
        const pEnd = part.indexOf("\r\n\r\n");
        if (pEnd < 0) continue;
        const pHeaders = parseMimeHeaders(part.substring(0, pEnd));
        const pBody = part.substring(pEnd + 4);
        const cte = pHeaders["content-transfer-encoding"] ?? "";
        const pType = pHeaders["content-type"] ?? "text/plain";
        const disposition = pHeaders["content-disposition"] ?? "";
        if (/attachment/i.test(disposition)) {
          // The RAW DECODED BYTES of the part (#69) — transfer-decoded so the
          // attachment is downloadable byte-for-byte (same convention as
          // req.files[x].content); size is that decoded byte length.
          const content = decodeAttachmentBytes(pBody, cte);
          attachments.push({
            filename: attachmentFilename(disposition, pType),
            contentType: pType.split(";")[0].trim(),
            size: content.length,
            content,
          });
        } else if (pType.includes("text/html")) {
          bodyHtml = decodeTransfer(pBody, cte).trim();
        } else if (pType.includes("text/plain")) {
          bodyText = decodeTransfer(pBody, cte).trim();
        }
      }
    }
  } else if (contentType.includes("text/html")) {
    bodyHtml = decodeTransfer(bodySection, headers["content-transfer-encoding"] ?? "").trim();
  } else {
    bodyText = decodeTransfer(bodySection, headers["content-transfer-encoding"] ?? "").trim();
  }

  return { headers, bodyText, bodyHtml, attachments };
}

/** The inbox()/search() listing row: {uid, subject, from, to, date, snippet, seen} (G3/G4). */
function parseSummary(uid: string, response: string): ImapMessage {
  const { headers, bodyText, bodyHtml } = parseMessage(response);
  return {
    uid,
    subject: headers["subject"] ?? "",
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    date: toIsoDate(headers["date"] ?? ""),
    snippet: makeSnippet(bodyText, bodyHtml),
    seen: /\\Seen/i.test(response),
  };
}

function parseFullMessage(uid: string, response: string): ImapFullMessage {
  const { headers, bodyText, bodyHtml, attachments } = parseMessage(response);
  return {
    uid,
    subject: headers["subject"] ?? "",
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    cc: headers["cc"] ?? "",
    date: toIsoDate(headers["date"] ?? ""),
    bodyText,
    bodyHtml,
    attachments,
    headers,
  };
}

/**
 * Create a Messenger configured for the current environment.
 *
 * Returns ONE concrete type, always. It used to return `Messenger | DevMailbox`,
 * and those two shared NO sending method -- DevMailbox has capture(), Messenger has
 * send() -- so the documented call threw TypeError whenever the dev branch was
 * taken. That is nodejs#41. Capture is now a branch inside Messenger.send(), so the
 * object you get back has one send() with one signature either way.
 *
 * The gate is availability, not verbosity:
 *   - no TINA4_MAIL_HOST -> capture (sending is impossible, so simulate it)
 *   - TINA4_MAIL_CAPTURE truthy -> capture even with SMTP configured
 *   - otherwise -> send, EVEN WITH TINA4_DEBUG ON
 *
 * TINA4_DEBUG no longer forces capture: debug must still be able to send real mail.
 * The `NODE_ENV !== "production"` clause is also gone -- it captured even with SMTP
 * configured and debug off, which silently ate every staging email.
 */
export function createMessenger(): Messenger {
  return new Messenger();
}
