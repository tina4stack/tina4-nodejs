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

// ── Types ────────────────────────────────────────────────────

export interface SendResult {
  success: boolean;
  message: string;
  id?: string;
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

export interface ImapFullMessage {
  uid: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
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
  private imapHost: string;
  private imapPort: number;
  private imapUser: string;
  private imapPass: string;
  private imapEncryption: string;

  constructor(options?: MessengerOptions) {
    // Priority: constructor > TINA4_MAIL_* > sensible default.
    // Legacy SMTP_*/IMAP_* env vars were removed in v3.12 — boot guard rejects them.
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
    const toList = Array.isArray(options.to) ? options.to : [options.to];
    const ccList = Array.isArray(options.cc) ? options.cc : (options.cc ? [options.cc] : []);
    const bccList = Array.isArray(options.bcc) ? options.bcc : (options.bcc ? [options.bcc] : []);
    const allRecipients = [...toList, ...ccList, ...bccList];
    const messageId = `${randomUUID()}@${this.host}`;

    if (allRecipients.length === 0) {
      return { success: false, message: "No recipients specified" };
    }

    if (!this.fromAddress) {
      return { success: false, message: "No from address configured" };
    }

    try {
      // Connect
      let socket: net.Socket | tls.TLSSocket;

      if (this.port === 465) {
        // Implicit TLS (SMTPS)
        socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false });
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

      // Read greeting
      const greeting = await readResponse(socket);
      if (greeting.code !== 220) {
        socket.destroy();
        return { success: false, message: `SMTP greeting failed: ${greeting.text}` };
      }

      // EHLO
      const ehlo = await sendCommand(socket, `EHLO ${this.host}`);
      if (ehlo.code !== 250) {
        socket.destroy();
        return { success: false, message: `EHLO failed: ${ehlo.text}` };
      }

      // STARTTLS upgrade (for port 587 or when useTls is true and not already TLS)
      if (this.useTls && this.port !== 465 && ehlo.text.includes("STARTTLS")) {
        const starttls = await sendCommand(socket, "STARTTLS");
        if (starttls.code !== 220) {
          socket.destroy();
          return { success: false, message: `STARTTLS failed: ${starttls.text}` };
        }

        // Upgrade to TLS
        const plainSocket = socket as net.Socket;
        socket = tls.connect(
          { socket: plainSocket, host: this.host, rejectUnauthorized: false },
        );
        await new Promise<void>((resolve, reject) => {
          (socket as tls.TLSSocket).once("secureConnect", resolve);
          (socket as tls.TLSSocket).once("error", reject);
        });

        // Re-EHLO after TLS upgrade
        const ehlo2 = await sendCommand(socket, `EHLO ${this.host}`);
        if (ehlo2.code !== 250) {
          socket.destroy();
          return { success: false, message: `EHLO after STARTTLS failed: ${ehlo2.text}` };
        }
      }

      // AUTH LOGIN
      if (this.username && this.password) {
        const auth = await sendCommand(socket, "AUTH LOGIN");
        if (auth.code !== 334) {
          socket.destroy();
          return { success: false, message: `AUTH LOGIN failed: ${auth.text}` };
        }

        const userResp = await sendCommand(socket, Buffer.from(this.username).toString("base64"));
        if (userResp.code !== 334) {
          socket.destroy();
          return { success: false, message: `AUTH username failed: ${userResp.text}` };
        }

        const passResp = await sendCommand(socket, Buffer.from(this.password).toString("base64"));
        if (passResp.code !== 235) {
          socket.destroy();
          return { success: false, message: `AUTH password failed: ${passResp.text}` };
        }
      }

      // MAIL FROM
      const mailFrom = await sendCommand(socket, `MAIL FROM:<${this.fromAddress}>`);
      if (mailFrom.code !== 250) {
        socket.destroy();
        return { success: false, message: `MAIL FROM failed: ${mailFrom.text}` };
      }

      // RCPT TO for all recipients
      for (const recipient of allRecipients) {
        const rcpt = await sendCommand(socket, `RCPT TO:<${recipient}>`);
        if (rcpt.code !== 250 && rcpt.code !== 251) {
          socket.destroy();
          return { success: false, message: `RCPT TO <${recipient}> failed: ${rcpt.text}` };
        }
      }

      // DATA
      const dataCmd = await sendCommand(socket, "DATA");
      if (dataCmd.code !== 354) {
        socket.destroy();
        return { success: false, message: `DATA failed: ${dataCmd.text}` };
      }

      // Build and send the MIME message
      const mimeMessage = buildMimeMessage({
        from: this.fromAddress,
        fromName: this.fromName,
        to: toList,
        cc: ccList,
        subject: options.subject,
        body: options.body,
        html: options.html ?? false,
        text: options.text,
        replyTo: options.replyTo,
        attachments: options.attachments,
        headers: options.headers,
        messageId,
      });

      // Send message body, terminate with <CRLF>.<CRLF>
      const endData = await sendCommand(socket, mimeMessage + "\r\n.");
      if (endData.code !== 250) {
        socket.destroy();
        return { success: false, message: `Message delivery failed: ${endData.text}` };
      }

      // QUIT
      await sendCommand(socket, "QUIT");
      socket.destroy();

      return { success: true, message: "Email sent successfully", id: messageId };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `SMTP error: ${errMsg}` };
    }
  }

  /**
   * Test the SMTP connection without sending an email.
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      let socket: net.Socket | tls.TLSSocket;

      if (this.port === 465) {
        socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false });
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
      socket = tls.connect({ host: this.imapHost, port: this.imapPort, rejectUnauthorized: false });
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
  async inbox(limit: number = 20, offset: number = 0, folder: string = "INBOX"): Promise<ImapMessage[]> {
    const socket = await this.imapConnect();
    try {
      // Select folder
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);

      // Search for all messages
      const searchResp = await imapCommand(socket, "SEARCH ALL");
      const uids = parseSearchResponse(searchResp);
      if (uids.length === 0) return [];

      // Latest first
      uids.reverse();
      const selected = uids.slice(offset, offset + limit);
      if (selected.length === 0) return [];

      const messages: ImapMessage[] = [];
      for (const uid of selected) {
        const fetchResp = await imapCommand(socket, `FETCH ${uid} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
        messages.push(parseHeaderResponse(uid, fetchResp));
      }

      return messages;
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Read a single message by sequence number or UID.
   */
  async read(uid: string, folder: string = "INBOX"): Promise<ImapFullMessage> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const fetchResp = await imapCommand(socket, `FETCH ${uid} (FLAGS BODY[])`);

      // Mark as seen
      await imapCommand(socket, `STORE ${uid} +FLAGS (\\Seen)`);

      return parseFullMessage(uid, fetchResp);
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
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const searchResp = await imapCommand(socket, `SEARCH ${query}`);
      const uids = parseSearchResponse(searchResp);
      if (uids.length === 0) return [];

      uids.reverse();
      const messages: ImapMessage[] = [];
      for (const uid of uids.slice(0, limit)) {
        const fetchResp = await imapCommand(socket, `FETCH ${uid} (FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])`);
        messages.push(parseHeaderResponse(uid, fetchResp));
      }
      return messages;
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Delete a message by UID.
   */
  async deleteMessage(uid: string, folder: string = "INBOX"): Promise<void> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      await imapCommand(socket, `STORE ${uid} +FLAGS (\\Deleted)`);
      await imapCommand(socket, "EXPUNGE");
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Mark a message as read.
   */
  async markRead(uid: string, folder: string = "INBOX"): Promise<void> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      await imapCommand(socket, `STORE ${uid} +FLAGS (\\Seen)`);
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * Count unseen messages in a folder.
   */
  async unread(folder: string = "INBOX"): Promise<number> {
    const socket = await this.imapConnect();
    try {
      await imapCommand(socket, `SELECT ${imapQuote(folder)}`);
      const searchResp = await imapCommand(socket, "SEARCH UNSEEN");
      return parseSearchResponse(searchResp).length;
    } finally {
      await this.imapDisconnect(socket);
    }
  }

  /**
   * List available IMAP folders/mailboxes.
   */
  async folders(): Promise<string[]> {
    const socket = await this.imapConnect();
    try {
      const resp = await imapCommand(socket, 'LIST "" "*"');
      const result: string[] = [];
      for (const line of resp.split("\r\n")) {
        // Parse LIST response: * LIST (\flags) "/" "FolderName"
        const m = line.match(/\* LIST \([^)]*\) "[^"]*" "?([^"\r\n]+)"?/i);
        if (m) result.push(m[1]);
      }
      return result;
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
      // Look for tagged response line indicating completion
      if (buffer.includes(`${tag} OK`) || buffer.includes(`${tag} NO`) || buffer.includes(`${tag} BAD`)) {
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
    socket.write(fullCommand, "utf-8");
  });
}

function parseSearchResponse(response: string): string[] {
  // SEARCH response: * SEARCH 1 2 3 4 5
  const match = response.match(/\* SEARCH (.+)/);
  if (!match) return [];
  return match[1].trim().split(/\s+/).filter((s) => /^\d+$/.test(s));
}

function parseHeaderResponse(uid: string, response: string): ImapMessage {
  const headers: Record<string, string> = {};
  const headerBlock = response.match(/\r\n([\s\S]*?)\r\n\)/);
  if (headerBlock) {
    const lines = headerBlock[1].split(/\r\n/);
    let currentKey = "";
    for (const line of lines) {
      if (/^\s/.test(line) && currentKey) {
        headers[currentKey] += " " + line.trim();
      } else {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          currentKey = line.substring(0, colonIdx).trim().toLowerCase();
          headers[currentKey] = line.substring(colonIdx + 1).trim();
        }
      }
    }
  }

  const seen = /\\Seen/i.test(response);

  return {
    uid,
    subject: headers["subject"] ?? "",
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    date: headers["date"] ?? "",
    snippet: "",
    seen,
  };
}

function parseFullMessage(uid: string, response: string): ImapFullMessage {
  // Extract the raw message body from FETCH response
  const bodyMatch = response.match(/\{(\d+)\}\r\n([\s\S]*)/);
  const rawMessage = bodyMatch ? bodyMatch[2] : response;

  // Split headers and body
  const headerEnd = rawMessage.indexOf("\r\n\r\n");
  const headerSection = headerEnd > 0 ? rawMessage.substring(0, headerEnd) : rawMessage;
  const bodySection = headerEnd > 0 ? rawMessage.substring(headerEnd + 4) : "";

  // Parse headers
  const headers: Record<string, string> = {};
  const headerLines = headerSection.split(/\r\n/);
  let currentKey = "";
  for (const line of headerLines) {
    if (/^\s/.test(line) && currentKey) {
      headers[currentKey] += " " + line.trim();
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        currentKey = line.substring(0, colonIdx).trim().toLowerCase();
        headers[currentKey] = line.substring(colonIdx + 1).trim();
      }
    }
  }

  // Determine content type
  const contentType = headers["content-type"] ?? "text/plain";
  let bodyText = "";
  let bodyHtml = "";

  if (contentType.includes("multipart")) {
    // Extract boundary
    const boundaryMatch = contentType.match(/boundary="?([^";\s]+)"?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = bodySection.split("--" + boundary);
      for (const part of parts) {
        if (part.trim() === "" || part.trim() === "--") continue;
        const partHeaderEnd = part.indexOf("\r\n\r\n");
        const partHeaders = partHeaderEnd > 0 ? part.substring(0, partHeaderEnd).toLowerCase() : "";
        const partBody = partHeaderEnd > 0 ? part.substring(partHeaderEnd + 4).trim() : "";
        if (partHeaders.includes("text/html")) {
          bodyHtml = partBody;
        } else if (partHeaders.includes("text/plain")) {
          bodyText = partBody;
        }
      }
    }
  } else if (contentType.includes("text/html")) {
    bodyHtml = bodySection;
  } else {
    bodyText = bodySection;
  }

  // Clean up trailing IMAP response data
  bodyText = bodyText.replace(/\)\r\n[A-Z]\d+ OK.*$/s, "").trim();
  bodyHtml = bodyHtml.replace(/\)\r\n[A-Z]\d+ OK.*$/s, "").trim();

  return {
    uid,
    subject: headers["subject"] ?? "",
    from: headers["from"] ?? "",
    to: headers["to"] ?? "",
    cc: headers["cc"] ?? "",
    date: headers["date"] ?? "",
    bodyText,
    bodyHtml,
    headers,
  };
}
