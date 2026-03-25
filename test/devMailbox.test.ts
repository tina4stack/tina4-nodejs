/**
 * Unit tests for the DevMailbox (packages/core/src/devMailbox.ts).
 * Run with: npx vitest run test/devMailbox.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevMailbox } from "../packages/core/src/devMailbox.ts";

// ── Helpers ──────────────────────────────────────────────────

let mailboxDir: string;
let mailbox: DevMailbox;

beforeEach(() => {
  mailboxDir = mkdtempSync(join(tmpdir(), "tina4-devmailbox-test-"));
  mailbox = new DevMailbox(mailboxDir);
});

afterAll(() => {
  // Clean up any leftover temp dirs
  try {
    if (mailboxDir) rmSync(mailboxDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ── Class Existence ──────────────────────────────────────────

describe("DevMailbox — class existence", () => {
  it("DevMailbox class exists and is constructable", () => {
    expect(DevMailbox).toBeDefined();
    expect(typeof DevMailbox).toBe("function");
    const mb = new DevMailbox(mailboxDir);
    expect(mb).toBeInstanceOf(DevMailbox);
  });

  it("has capture, inbox, read, delete, clear, and count methods", () => {
    expect(typeof mailbox.capture).toBe("function");
    expect(typeof mailbox.inbox).toBe("function");
    expect(typeof mailbox.read).toBe("function");
    expect(typeof mailbox.delete).toBe("function");
    expect(typeof mailbox.clear).toBe("function");
    expect(typeof mailbox.count).toBe("function");
  });
});

// ── capture() ────────────────────────────────────────────────

describe("DevMailbox — capture()", () => {
  it("stores a message and returns success", () => {
    const result = mailbox.capture({
      to: "alice@test.com",
      subject: "Hello",
      body: "Hi Alice!",
    });
    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
  });

  it("assigns a unique id to each captured message", () => {
    const r1 = mailbox.capture({ to: "a@test.com", subject: "One", body: "1" });
    const r2 = mailbox.capture({ to: "b@test.com", subject: "Two", body: "2" });
    expect(r1.id).not.toBe(r2.id);
  });

  it("accepts an array of recipients", () => {
    const result = mailbox.capture({
      to: ["alice@test.com", "bob@test.com"],
      subject: "Group",
      body: "Hello everyone",
    });
    expect(result.success).toBe(true);
  });
});

// ── inbox() / list ───────────────────────────────────────────

describe("DevMailbox — inbox() returns captured messages", () => {
  it("returns an empty array when no messages exist", () => {
    const messages = mailbox.inbox();
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(0);
  });

  it("returns captured messages in the inbox", () => {
    mailbox.capture({ to: "a@test.com", subject: "Test", body: "Body" });
    mailbox.capture({ to: "b@test.com", subject: "Test2", body: "Body2" });

    const messages = mailbox.inbox();
    expect(messages.length).toBe(2);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      mailbox.capture({ to: `u${i}@test.com`, subject: `Msg ${i}`, body: "x" });
    }
    const limited = mailbox.inbox(3);
    expect(limited.length).toBe(3);
  });
});

// ── clear() ──────────────────────────────────────────────────

describe("DevMailbox — clear()", () => {
  it("empties the mailbox completely", () => {
    mailbox.capture({ to: "a@test.com", subject: "Keep", body: "data" });
    mailbox.capture({ to: "b@test.com", subject: "Keep2", body: "data2" });

    expect(mailbox.inbox().length).toBe(2);
    mailbox.clear();
    expect(mailbox.inbox().length).toBe(0);
  });

  it("clears only a specific folder when specified", () => {
    mailbox.capture({ to: "a@test.com", subject: "Test", body: "body" });

    // Clear only inbox — outbox should still have messages
    mailbox.clear("inbox");
    expect(mailbox.inbox(50, 0, "inbox").length).toBe(0);
    expect(mailbox.inbox(50, 0, "outbox").length).toBe(1);
  });

  it("can be called on an already empty mailbox without error", () => {
    expect(() => mailbox.clear()).not.toThrow();
  });
});

// ── Message Structure ────────────────────────────────────────

describe("DevMailbox — message structure", () => {
  it("captured messages have to, from, subject, body, and date fields", () => {
    mailbox.capture({
      to: "alice@test.com",
      from: "sender@test.com",
      subject: "Structure Test",
      body: "Check fields",
    });

    const messages = mailbox.inbox();
    expect(messages.length).toBe(1);

    const msg = messages[0];
    expect(msg.to).toBeDefined();
    expect(Array.isArray(msg.to)).toBe(true);
    expect(msg.to).toContain("alice@test.com");
    expect(msg.from).toBe("sender@test.com");
    expect(msg.subject).toBe("Structure Test");
    expect(msg.body).toBe("Check fields");
    expect(msg.date).toBeDefined();
    expect(typeof msg.date).toBe("string");
  });

  it("message date is a valid ISO timestamp", () => {
    mailbox.capture({ to: "x@test.com", subject: "Date", body: "body" });
    const msg = mailbox.inbox()[0];
    const parsed = new Date(msg.date);
    expect(parsed.getTime()).not.toBeNaN();
  });

  it("message has id, type, cc, bcc, html, attachments, and read fields", () => {
    mailbox.capture({ to: "x@test.com", subject: "Full", body: "body" });
    const msg = mailbox.inbox()[0];
    expect(msg.id).toBeDefined();
    expect(msg.type).toBe("inbox");
    expect(Array.isArray(msg.cc)).toBe(true);
    expect(Array.isArray(msg.bcc)).toBe(true);
    expect(typeof msg.html).toBe("boolean");
    expect(Array.isArray(msg.attachments)).toBe(true);
    expect(typeof msg.read).toBe("boolean");
  });
});

// ── read() and delete() ─────────────────────────────────────

describe("DevMailbox — read() and delete()", () => {
  it("read() retrieves a message by ID and marks it as read", () => {
    const result = mailbox.capture({ to: "a@test.com", subject: "Read me", body: "hi" });
    const msg = mailbox.read(result.id!);
    expect(msg).not.toBeNull();
    expect(msg!.subject).toBe("Read me");
    expect(msg!.read).toBe(true);
  });

  it("read() returns null for a non-existent ID", () => {
    const msg = mailbox.read("non-existent-id");
    expect(msg).toBeNull();
  });

  it("delete() removes a message by ID", () => {
    const result = mailbox.capture({ to: "a@test.com", subject: "Delete me", body: "bye" });
    const deleted = mailbox.delete(result.id!);
    expect(deleted).toBe(true);
    expect(mailbox.read(result.id!)).toBeNull();
  });

  it("delete() returns false for a non-existent ID", () => {
    const deleted = mailbox.delete("non-existent-id");
    expect(deleted).toBe(false);
  });
});
