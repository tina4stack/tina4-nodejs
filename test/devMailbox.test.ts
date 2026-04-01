/**
 * Unit tests for the DevMailbox (packages/core/src/devMailbox.ts).
 * Run with: npx tsx test/devMailbox.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DevMailbox } from "../packages/core/src/devMailbox.ts";

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

let mailboxDir: string;
let mailbox: DevMailbox;

function setup() {
  mailboxDir = mkdtempSync(join(tmpdir(), "tina4-devmailbox-test-"));
  mailbox = new DevMailbox(mailboxDir);
}

function cleanup() {
  try { rmSync(mailboxDir, { recursive: true, force: true }); } catch {}
}

console.log("=== DevMailbox Tests ===\n");

// --- Class Existence ---
console.log("--- Class Existence ---");

setup();
assert("DevMailbox class exists and is constructable", typeof DevMailbox === "function");
assert("instance is DevMailbox", mailbox instanceof DevMailbox);
assert("has capture method", typeof mailbox.capture === "function");
assert("has inbox method", typeof mailbox.inbox === "function");
assert("has read method", typeof mailbox.read === "function");
assert("has delete method", typeof mailbox.delete === "function");
assert("has clear method", typeof mailbox.clear === "function");
assert("has count method", typeof mailbox.count === "function");
cleanup();

// --- capture() ---
console.log("\n--- capture() ---");

setup();
const captureResult = mailbox.capture({
  to: "alice@test.com",
  subject: "Hello",
  body: "Hi Alice!",
});
assert("capture returns success", captureResult.success === true);
assert("capture returns id", typeof captureResult.id === "string");

const r1 = mailbox.capture({ to: "a@test.com", subject: "One", body: "1" });
const r2 = mailbox.capture({ to: "b@test.com", subject: "Two", body: "2" });
assert("unique ids for each message", r1.id !== r2.id);

const arrayResult = mailbox.capture({
  to: ["alice@test.com", "bob@test.com"],
  subject: "Group",
  body: "Hello everyone",
});
assert("accepts array of recipients", arrayResult.success === true);
cleanup();

// --- inbox() ---
console.log("\n--- inbox() ---");

setup();
const emptyInbox = mailbox.inbox();
assert("empty inbox returns array", Array.isArray(emptyInbox));
assert("empty inbox has 0 messages", emptyInbox.length === 0);

mailbox.capture({ to: "a@test.com", subject: "Test", body: "Body" });
mailbox.capture({ to: "b@test.com", subject: "Test2", body: "Body2" });
assert("inbox returns captured messages", mailbox.inbox().length === 2);

for (let i = 0; i < 5; i++) {
  mailbox.capture({ to: `u${i}@test.com`, subject: `Msg ${i}`, body: "x" });
}
assert("respects limit parameter", mailbox.inbox(3).length === 3);
cleanup();

// --- clear() ---
console.log("\n--- clear() ---");

setup();
mailbox.capture({ to: "a@test.com", subject: "Keep", body: "data" });
mailbox.capture({ to: "b@test.com", subject: "Keep2", body: "data2" });
assert("inbox has 2 before clear", mailbox.inbox().length === 2);
mailbox.clear();
assert("inbox empty after clear", mailbox.inbox().length === 0);

setup();
mailbox.capture({ to: "a@test.com", subject: "Test", body: "body" });
mailbox.clear("inbox");
assert("clear inbox only empties inbox", mailbox.inbox(50, 0, "inbox").length === 0);
assert("clear inbox keeps outbox", mailbox.inbox(50, 0, "outbox").length === 1);
cleanup();

setup();
try {
  mailbox.clear();
  assert("clear on empty mailbox does not throw", true);
} catch {
  assert("clear on empty mailbox does not throw", false);
}
cleanup();

// --- Message Structure ---
console.log("\n--- Message Structure ---");

setup();
mailbox.capture({
  to: "alice@test.com",
  from: "sender@test.com",
  subject: "Structure Test",
  body: "Check fields",
});
const msgs = mailbox.inbox();
assert("captured 1 message", msgs.length === 1);
const msg = msgs[0];
assert("msg.to is array", Array.isArray(msg.to));
assert("msg.to contains recipient", msg.to.includes("alice@test.com"));
assert("msg.from is sender", msg.from === "sender@test.com");
assert("msg.subject correct", msg.subject === "Structure Test");
assert("msg.body correct", msg.body === "Check fields");
assert("msg.date is string", typeof msg.date === "string");
assert("msg.date is valid ISO", !isNaN(new Date(msg.date).getTime()));
assert("msg.id exists", msg.id !== undefined);
assert("msg.type is inbox", msg.type === "inbox");
assert("msg.cc is array", Array.isArray(msg.cc));
assert("msg.bcc is array", Array.isArray(msg.bcc));
assert("msg.html is boolean", typeof msg.html === "boolean");
assert("msg.attachments is array", Array.isArray(msg.attachments));
assert("msg.read is boolean", typeof msg.read === "boolean");
cleanup();

// --- read() and delete() ---
console.log("\n--- read() and delete() ---");

setup();
const readResult = mailbox.capture({ to: "a@test.com", subject: "Read me", body: "hi" });
const readMsg = mailbox.read(readResult.id!);
assert("read retrieves message", readMsg !== null);
assert("read message has correct subject", readMsg!.subject === "Read me");
assert("read marks message as read", readMsg!.read === true);

assert("read returns null for non-existent", mailbox.read("non-existent-id") === null);

const delResult = mailbox.capture({ to: "a@test.com", subject: "Delete me", body: "bye" });
assert("delete returns true", mailbox.delete(delResult.id!) === true);
assert("deleted message is gone", mailbox.read(delResult.id!) === null);
assert("delete returns false for non-existent", mailbox.delete("non-existent-id") === false);
cleanup();

// --- CC and BCC ---
console.log("\n--- CC and BCC ---");

setup();
{
  const result = mailbox.capture({
    to: "alice@test.com",
    from: "sender@test.com",
    subject: "With CC",
    body: "Test CC",
    cc: ["cc1@test.com", "cc2@test.com"],
    bcc: ["bcc1@test.com"],
  });
  assert("capture with cc/bcc succeeds", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("cc is preserved", msg !== null && Array.isArray(msg!.cc) && msg!.cc.length === 2);
  assert("bcc is preserved", msg !== null && Array.isArray(msg!.bcc) && msg!.bcc.length === 1);
  assert("cc contains correct addresses", msg!.cc.includes("cc1@test.com"));
  assert("bcc contains correct address", msg!.bcc.includes("bcc1@test.com"));
}
cleanup();

// --- HTML content ---
console.log("\n--- HTML Content ---");

setup();
{
  const result = mailbox.capture({
    to: "alice@test.com",
    subject: "HTML Email",
    body: "<h1>Hello</h1><p>World</p>",
    html: true,
  });
  assert("capture with html flag succeeds", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("html flag is preserved", msg !== null && msg!.html === true);
  assert("html body is preserved", msg!.body.includes("<h1>"));
}
cleanup();

// --- Multiple recipients string ---
console.log("\n--- Multiple Recipients ---");

setup();
{
  const result = mailbox.capture({
    to: ["a@test.com", "b@test.com", "c@test.com"],
    subject: "Multi",
    body: "To multiple",
  });
  assert("capture with 3 recipients", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("all recipients preserved", msg !== null && msg!.to.length === 3);
}
cleanup();

// --- Default from ---
console.log("\n--- Default From ---");

setup();
{
  const result = mailbox.capture({
    to: "alice@test.com",
    subject: "No From",
    body: "Test",
  });
  const msg = mailbox.read(result.id!);
  assert("default from is set", msg !== null && typeof msg!.from === "string" && msg!.from.length > 0);
}
cleanup();

// --- count() ---
console.log("\n--- count() ---");

setup();
{
  const c0 = mailbox.count();
  assert("count returns object with total", typeof c0 === "object" && typeof c0.total === "number");
  assert("count is 0 initially", c0.total === 0);

  mailbox.capture({ to: "a@test.com", subject: "1", body: "1" });
  const c1 = mailbox.count();
  // capture stores in both inbox and outbox, so total = inbox + outbox = 2
  assert("count.inbox is 1 after 1 capture", c1.inbox === 1);
  assert("count.outbox is 1 after 1 capture", c1.outbox === 1);
  assert("count.total is 2 after 1 capture (inbox+outbox)", c1.total === 2);

  mailbox.capture({ to: "b@test.com", subject: "2", body: "2" });
  mailbox.capture({ to: "c@test.com", subject: "3", body: "3" });
  const c3 = mailbox.count();
  assert("count.inbox is 3 after 3 captures", c3.inbox === 3);
  assert("count.outbox is 3 after 3 captures", c3.outbox === 3);
  assert("count has inbox field", typeof c3.inbox === "number");
  assert("count has outbox field", typeof c3.outbox === "number");

  mailbox.clear();
  const cCleared = mailbox.count();
  assert("count.total is 0 after clear", cCleared.total === 0);
}
cleanup();

// --- inbox pagination ---
console.log("\n--- Inbox Pagination ---");

setup();
{
  for (let i = 0; i < 10; i++) {
    mailbox.capture({ to: `u${i}@test.com`, subject: `Msg ${i}`, body: `Body ${i}` });
  }

  const page1 = mailbox.inbox(3, 0);
  assert("page 1 has 3 messages", page1.length === 3);

  const page2 = mailbox.inbox(3, 3);
  assert("page 2 has 3 messages", page2.length === 3);

  const page4 = mailbox.inbox(3, 9);
  assert("last page has 1 message", page4.length === 1);

  const beyondEnd = mailbox.inbox(3, 20);
  assert("beyond end returns empty", beyondEnd.length === 0);
}
cleanup();

// --- Persistence across instances ---
console.log("\n--- Persistence ---");

setup();
{
  mailbox.capture({ to: "persist@test.com", subject: "Persist", body: "Data" });

  // Create a new mailbox instance pointing to the same directory
  const mailbox2 = new DevMailbox(mailboxDir);
  const inbox2 = mailbox2.inbox();
  assert("new instance sees persisted messages", inbox2.length === 1);
  assert("persisted message has correct subject", inbox2[0].subject === "Persist");
}
cleanup();

// --- Empty subject and body ---
console.log("\n--- Empty Subject and Body ---");

setup();
{
  const result = mailbox.capture({ to: "a@test.com", subject: "", body: "" });
  assert("empty subject/body capture succeeds", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("empty subject preserved", msg !== null && msg!.subject === "");
  assert("empty body preserved", msg !== null && msg!.body === "");
}
cleanup();

// --- Long subject and body ---
console.log("\n--- Long Content ---");

setup();
{
  const longSubject = "A".repeat(500);
  const longBody = "B".repeat(10000);
  const result = mailbox.capture({ to: "a@test.com", subject: longSubject, body: longBody });
  assert("long content capture succeeds", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("long subject preserved", msg !== null && msg!.subject.length === 500);
  assert("long body preserved", msg !== null && msg!.body.length === 10000);
}
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
