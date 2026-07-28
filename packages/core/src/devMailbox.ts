/**
 * Tina4 DevMailbox — File-backed development mailbox, zero dependencies.
 *
 * Captures emails to the filesystem instead of sending them via SMTP.
 * Perfect for local development — no email server needed.
 *
 *   import { DevMailbox, createMessenger } from "@tina4/core";
 *
 *   const mailbox = new DevMailbox();
 *   mailbox.capture("alice@test.com", "Hello", "Hi!");
 *   const messages = mailbox.inbox();
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { SendResult, EmailMessage } from "./messenger.js";

// ── DevMailbox ───────────────────────────────────────────────

export class DevMailbox {
  private mailboxDir: string;

  constructor(mailboxDir?: string) {
    this.mailboxDir = mailboxDir ?? process.env.TINA4_MAILBOX_DIR ?? "data/mailbox";
  }

  /**
   * Ensure a folder directory exists.
   */
  private ensureFolder(folder: string): string {
    const dir = join(this.mailboxDir, folder);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Capture an email to the dev mailbox instead of sending it.
   *
   * The parameter order MATCHES Messenger.send() on purpose. It did not before:
   * send()'s 5th positional was `text` and capture()'s was `cc`, so the same call
   * meant different things depending on which door it came through -- that mismatch
   * IS nodejs#42.
   *
   * BREAKING: `text` is now the 5th positional. A caller passing cc positionally
   * must move it. Aligning the two signatures is the fix; leaving them apart would
   * preserve the bug.
   */
  capture(
    to: string | string[],
    subject: string,
    body: string,
    html: boolean = false,
    text?: string,
    cc: string | string[] = [],
    bcc: string | string[] = [],
    replyTo?: string,
    attachments: string[] = [],
    from?: string,
  ): SendResult {
    const id = randomUUID();
    const toList = Array.isArray(to) ? to : [to];
    // Normalised HERE, at the boundary, so a message is well formed however it
    // arrived. A dev mailbox that stores a malformed message and reports success
    // defeats its own purpose -- it exists to show you what you WOULD have sent.
    const ccList = Array.isArray(cc) ? cc : (cc ? [cc] : []);
    const bccList = Array.isArray(bcc) ? bcc : (bcc ? [bcc] : []);
    const now = new Date().toISOString();

    const message: EmailMessage = {
      id,
      type: "outbox",
      from: from ?? process.env.TINA4_MAIL_FROM ?? "dev@localhost",
      to: toList,
      cc: ccList,
      bcc: bccList,
      reply_to: replyTo,
      subject,
      body,
      text,
      html,
      attachments,
      date: now,
      read: false,
    };

    // Save to outbox
    const outboxDir = this.ensureFolder("outbox");
    writeFileSync(join(outboxDir, `${id}.json`), JSON.stringify(message, null, 2));

    // Also save a copy to each recipient's inbox
    const inboxDir = this.ensureFolder("inbox");
    const inboxMessage: EmailMessage = { ...message, type: "inbox" };
    writeFileSync(join(inboxDir, `${id}.json`), JSON.stringify(inboxMessage, null, 2));

    return { success: true, message: "Email captured to dev mailbox", id };
  }

  /**
   * List messages from a folder (default: inbox).
   */
  inbox(limit: number = 50, offset: number = 0, folder: string = "inbox"): EmailMessage[] {
    const dir = this.ensureFolder(folder);
    const results: EmailMessage[] = [];

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse();
    } catch {
      return [];
    }

    const sliced = files.slice(offset, offset + limit);

    for (const file of sliced) {
      try {
        const msg: EmailMessage = JSON.parse(readFileSync(join(dir, file), "utf-8"));
        results.push(msg);
      } catch {
        // skip corrupt files
      }
    }

    return results;
  }

  /**
   * Read a single message by ID. Searches all folders.
   */
  read(msgId: string): EmailMessage | null {
    const folders = ["inbox", "outbox"];

    for (const folder of folders) {
      const filePath = join(this.mailboxDir, folder, `${msgId}.json`);
      if (existsSync(filePath)) {
        try {
          const msg: EmailMessage = JSON.parse(readFileSync(filePath, "utf-8"));
          // Mark as read
          msg.read = true;
          writeFileSync(filePath, JSON.stringify(msg, null, 2));
          return msg;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  /**
   * Count unread messages in the inbox.
   */
  unreadCount(): number {
    const dir = this.ensureFolder("inbox");
    let count = 0;

    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const msg: EmailMessage = JSON.parse(readFileSync(join(dir, file), "utf-8"));
          if (!msg.read) count++;
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // directory might not exist
    }

    return count;
  }

  /**
   * Delete a message by ID. Removes from all folders.
   */
  delete(msgId: string): boolean {
    let deleted = false;
    const folders = ["inbox", "outbox"];

    for (const folder of folders) {
      const filePath = join(this.mailboxDir, folder, `${msgId}.json`);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          deleted = true;
        } catch {
          // ignore
        }
      }
    }

    return deleted;
  }

  /**
   * Clear all messages from a folder, or all folders if none specified.
   */
  clear(folder?: string): void {
    const folders = folder ? [folder] : ["inbox", "outbox"];

    for (const f of folders) {
      const dir = join(this.mailboxDir, f);
      try {
        if (existsSync(dir)) {
          const files = readdirSync(dir).filter((file) => file.endsWith(".json"));
          for (const file of files) {
            unlinkSync(join(dir, file));
          }
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Seed the mailbox with sample messages for development.
   */
  seed(count: number = 5): void {
    const subjects = [
      "Welcome to Tina4",
      "Your account has been created",
      "Weekly digest",
      "Action required: Verify your email",
      "New feature announcement",
      "Security alert: New login detected",
      "Invoice #1234",
      "Meeting reminder",
      "Password reset request",
      "Feedback requested",
    ];

    const senders = [
      "noreply@tina4.com",
      "admin@example.com",
      "support@company.com",
      "billing@service.io",
      "alerts@monitoring.dev",
    ];

    for (let i = 0; i < count; i++) {
      const subject = subjects[i % subjects.length];
      const from = senders[i % senders.length];
      const date = new Date(Date.now() - i * 3600000).toISOString();
      const id = randomUUID();

      const message: EmailMessage = {
        id,
        type: "inbox",
        from,
        to: ["dev@localhost"],
        cc: [],
        bcc: [],
        subject,
        body: `This is sample email #${i + 1}.\n\nGenerated by DevMailbox.seed() for development purposes.`,
        html: false,
        attachments: [],
        date,
        read: i > 1, // first two are unread
      };

      const dir = this.ensureFolder("inbox");
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(message, null, 2));
    }
  }

  /**
   * Count messages in a folder, or all folders if none specified.
   */
  count(folder?: string): { inbox: number; outbox: number; total: number } {
    const countDir = (f: string): number => {
      const dir = join(this.mailboxDir, f);
      try {
        if (existsSync(dir)) {
          return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
        }
      } catch {
        // ignore
      }
      return 0;
    };

    if (folder) {
      const c = countDir(folder);
      return { inbox: folder === "inbox" ? c : 0, outbox: folder === "outbox" ? c : 0, total: c };
    }

    const inbox = countDir("inbox");
    const outbox = countDir("outbox");
    return { inbox, outbox, total: inbox + outbox };
  }
}

// ── Factory ──────────────────────────────────────────────────
