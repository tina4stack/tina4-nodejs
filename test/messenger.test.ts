/**
 * Unit tests for the Messenger and DevMailbox modules.
 * Run with: npx tsx test/messenger.test.ts
 *
 * Tests the Messenger class structure, DevMailbox file-backed mailbox,
 * and the createMessenger factory. No actual SMTP/IMAP connections.
 */
import {
  Messenger, DevMailbox, createMessenger,
} from "../packages/core/src/index.ts";
import type { SendResult, EmailMessage } from "../packages/core/src/index.ts";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const TEST_DIR = join("/tmp", "tina4-messenger-test-" + Date.now());

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
}

cleanup();

console.log("=== Messenger Tests ===\n");

// --- Messenger class exists ---
console.log("--- Messenger class ---");

const messenger = new Messenger({ host: "localhost", port: 25 });
assert("Messenger constructor works", messenger !== null);
assert("Messenger has send method", typeof messenger.send === "function");
assert("Messenger has testConnection method", typeof messenger.testConnection === "function");
assert("Messenger has inbox method", typeof messenger.inbox === "function");
assert("Messenger has read method", typeof messenger.read === "function");
assert("Messenger has search method", typeof messenger.search === "function");
assert("Messenger has markRead method", typeof messenger.markRead === "function");
assert("Messenger has deleteMessage method", typeof messenger.deleteMessage === "function");
assert("Messenger has unread method", typeof messenger.unread === "function");
assert("Messenger has testImapConnection method", typeof messenger.testImapConnection === "function");

// --- DevMailbox basics ---
console.log("\n--- DevMailbox basics ---");

const mailbox = new DevMailbox(TEST_DIR);
assert("DevMailbox constructor works", mailbox !== null);
assert("DevMailbox has capture method", typeof mailbox.capture === "function");
assert("DevMailbox has inbox method", typeof mailbox.inbox === "function");
assert("DevMailbox has read method", typeof mailbox.read === "function");
assert("DevMailbox has clear method", typeof mailbox.clear === "function");
assert("DevMailbox has delete method", typeof mailbox.delete === "function");
assert("DevMailbox has unreadCount method", typeof mailbox.unreadCount === "function");
assert("DevMailbox has count method", typeof mailbox.count === "function");
assert("DevMailbox has seed method", typeof mailbox.seed === "function");

// --- DevMailbox capture ---
console.log("\n--- DevMailbox capture ---");

const result = mailbox.capture({
  to: "alice@test.com",
  subject: "Hello",
  body: "Hi there!",
});

assert("capture returns success", result.success === true);
assert("capture returns message", typeof result.message === "string");
assert("capture returns id", typeof result.id === "string");

// --- DevMailbox inbox ---
console.log("\n--- DevMailbox inbox ---");

const inbox = mailbox.inbox();
assert("inbox returns array", Array.isArray(inbox));
assert("inbox has 1 message after capture", inbox.length === 1);
assert("inbox message has correct subject", inbox[0].subject === "Hello");
assert("inbox message has correct to", inbox[0].to.includes("alice@test.com"));
assert("inbox message has id", typeof inbox[0].id === "string");
assert("inbox message has date", typeof inbox[0].date === "string");

// --- DevMailbox outbox ---
console.log("\n--- DevMailbox outbox ---");

const outbox = mailbox.inbox(50, 0, "outbox");
assert("outbox returns array", Array.isArray(outbox));
assert("outbox has 1 message after capture", outbox.length === 1);
assert("outbox message type is outbox", outbox[0].type === "outbox");

// --- DevMailbox read ---
console.log("\n--- DevMailbox read ---");

const msgId = inbox[0].id;
const readMsg = mailbox.read(msgId);
assert("read returns message", readMsg !== null);
assert("read message has correct subject", readMsg?.subject === "Hello");
assert("read marks message as read", readMsg?.read === true);

const readNull = mailbox.read("nonexistent-id");
assert("read returns null for unknown id", readNull === null);

// --- DevMailbox count ---
console.log("\n--- DevMailbox count ---");

const counts = mailbox.count();
assert("count returns inbox count", counts.inbox === 1);
assert("count returns outbox count", counts.outbox === 1);
assert("count returns total", counts.total === 2);

// --- DevMailbox unreadCount ---
console.log("\n--- DevMailbox unreadCount ---");

// Capture another message (unread)
mailbox.capture({ to: "bob@test.com", subject: "Unread", body: "New message" });
const unread = mailbox.unreadCount();
assert("unreadCount returns count of unread messages", unread >= 1);

// --- DevMailbox multiple captures ---
console.log("\n--- Multiple captures ---");

mailbox.capture({ to: ["c@test.com"], subject: "Third", body: "3", cc: ["cc@test.com"] });
const inboxAfter = mailbox.inbox();
assert("inbox has 3 messages after 3 captures", inboxAfter.length === 3);

// --- DevMailbox delete ---
console.log("\n--- DevMailbox delete ---");

const deleteId = inboxAfter[0].id;
const deleted = mailbox.delete(deleteId);
assert("delete returns true for existing message", deleted === true);

const deleteFalse = mailbox.delete("nonexistent-id");
assert("delete returns false for unknown id", deleteFalse === false);

// --- DevMailbox clear ---
console.log("\n--- DevMailbox clear ---");

mailbox.clear("inbox");
const afterClear = mailbox.inbox();
assert("inbox is empty after clear(inbox)", afterClear.length === 0);

mailbox.capture({ to: "x@test.com", subject: "New", body: "after clear" });
mailbox.clear(); // clear all
const afterClearAll = mailbox.count();
assert("all folders empty after clear()", afterClearAll.total === 0);

// --- DevMailbox seed ---
console.log("\n--- DevMailbox seed ---");

mailbox.seed(5);
const seeded = mailbox.inbox();
assert("seed creates messages", seeded.length === 5);

// --- DevMailbox pagination ---
console.log("\n--- DevMailbox pagination ---");

const page1 = mailbox.inbox(2, 0);
assert("pagination limit works", page1.length === 2);

const page2 = mailbox.inbox(2, 2);
assert("pagination offset works", page2.length === 2);

// --- createMessenger factory ---
console.log("\n--- createMessenger factory ---");

// Without SMTP_HOST set, should return DevMailbox
const origHost = process.env.SMTP_HOST;
const origEnv = process.env.NODE_ENV;
delete process.env.SMTP_HOST;
process.env.NODE_ENV = "development";

const devMsngr = createMessenger();
assert("createMessenger returns DevMailbox when no SMTP_HOST", devMsngr instanceof DevMailbox);

// Restore
if (origHost) process.env.SMTP_HOST = origHost;
if (origEnv) process.env.NODE_ENV = origEnv;

// Cleanup
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
