/**
 * Unit tests for the DevMailbox (packages/core/src/devMailbox.ts).
 * Run with: npx tsx test/devMailbox.test.ts
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
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

// --- Class Behaviour (constructed instance exercises its mailboxDir) ---
console.log("--- Class Behaviour ---");

// 1. A freshly-built DevMailbox bound to mailboxDir actually reads/writes that
//    directory: capture then inbox()[0].subject proves the round trip, not just
//    that the class is a function / instanceof.
setup();
{
  const cap = mailbox.capture("a@test.com", "Behaviour S", "Behaviour B");
  assert(
    "constructed DevMailbox captures+reads its mailboxDir (inbox[0].subject)",
    mailbox.inbox()[0]?.subject === "Behaviour S",
    `got ${JSON.stringify(mailbox.inbox()[0]?.subject)}`,
  );

  // 2. capture() returns a real success result with a string id (the wire shape
  //    callers depend on), not merely an invokable method.
  assert(
    "capture() returns success=true with a string id",
    cap.success === true && typeof cap.id === "string" && cap.id.length > 0,
    JSON.stringify(cap),
  );

  // 3. inbox() returns the persisted message after a capture (length === 1).
  assert("inbox() returns the one captured message", mailbox.inbox().length === 1);

  // 4. read(id) retrieves the captured message AND marks it read on disk.
  const got = mailbox.read(cap.id!);
  assert(
    "read(id) returns the captured message with matching subject",
    got !== null && got.subject === "Behaviour S",
  );
  assert("read(id) marks the message as read", got !== null && got.read === true);

  // 5. delete(id) removes the message: returns true, then read(id) is null.
  assert("delete(id) returns true for an existing message", mailbox.delete(cap.id!) === true);
  assert("read(id) returns null after delete", mailbox.read(cap.id!) === null);
}
cleanup();

// 6. clear() empties the inbox: capture, clear, inbox().length === 0.
setup();
{
  mailbox.capture("clear@test.com", "Clear S", "Clear B");
  assert("inbox has the captured message before clear", mailbox.inbox().length === 1);
  mailbox.clear();
  assert("inbox() is empty after clear()", mailbox.inbox().length === 0);
}
cleanup();

// 7. count() reflects real folder contents: one capture writes to inbox AND
//    outbox, so count().total === 2.
setup();
{
  mailbox.capture("count@test.com", "Count S", "Count B");
  const c = mailbox.count();
  assert(
    "count().total === 2 after one capture (inbox+outbox)",
    c.total === 2 && c.inbox === 1 && c.outbox === 1,
    JSON.stringify(c),
  );
}
cleanup();

// --- capture() ---
console.log("\n--- capture() ---");

setup();
const captureResult = mailbox.capture("alice@test.com", "Hello", "Hi Alice!");
assert("capture returns success", captureResult.success === true);
assert("capture returns id", typeof captureResult.id === "string");

const r1 = mailbox.capture("a@test.com", "One", "1");
const r2 = mailbox.capture("b@test.com", "Two", "2");
assert("unique ids for each message", r1.id !== r2.id);

const arrayResult = mailbox.capture(["alice@test.com", "bob@test.com"], "Group", "Hello everyone");
assert("accepts array of recipients", arrayResult.success === true);
cleanup();

// --- inbox() ---
console.log("\n--- inbox() ---");

setup();
const emptyInbox = mailbox.inbox();
assert("empty inbox returns array", Array.isArray(emptyInbox));
assert("empty inbox has 0 messages", emptyInbox.length === 0);

mailbox.capture("a@test.com", "Test", "Body");
mailbox.capture("b@test.com", "Test2", "Body2");
assert("inbox returns captured messages", mailbox.inbox().length === 2);

for (let i = 0; i < 5; i++) {
  mailbox.capture(`u${i}@test.com`, `Msg ${i}`, "x");
}
assert("respects limit parameter", mailbox.inbox(3).length === 3);
cleanup();

// --- clear() ---
console.log("\n--- clear() ---");

setup();
mailbox.capture("a@test.com", "Keep", "data");
mailbox.capture("b@test.com", "Keep2", "data2");
assert("inbox has 2 before clear", mailbox.inbox().length === 2);
mailbox.clear();
assert("inbox empty after clear", mailbox.inbox().length === 0);

setup();
mailbox.capture("a@test.com", "Test", "body");
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
// 5th slot is `text` from 3.13.94 (was cc). Passing 9 args against the old order
// silently shifted `from` off the end -- the same class of bug as nodejs#42.
mailbox.capture("alice@test.com", "Structure Test", "Check fields", false, undefined, [], [], undefined, [], "sender@test.com");
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
const readResult = mailbox.capture("a@test.com", "Read me", "hi");
const readMsg = mailbox.read(readResult.id!);
assert("read retrieves message", readMsg !== null);
assert("read message has correct subject", readMsg!.subject === "Read me");
assert("read marks message as read", readMsg!.read === true);

assert("read returns null for non-existent", mailbox.read("non-existent-id") === null);

const delResult = mailbox.capture("a@test.com", "Delete me", "bye");
assert("delete returns true", mailbox.delete(delResult.id!) === true);
assert("deleted message is gone", mailbox.read(delResult.id!) === null);
assert("delete returns false for non-existent", mailbox.delete("non-existent-id") === false);
cleanup();

// --- CC and BCC ---
console.log("\n--- CC and BCC ---");

setup();
{
  // `undefined` in the 5th slot is `text` from 3.13.94: capture()'s parameter order
  // now matches send(). It used to be cc there, and that mismatch WAS nodejs#42.
  const result = mailbox.capture("alice@test.com", "With CC", "Test CC", false, undefined, ["cc1@test.com", "cc2@test.com"], ["bcc1@test.com"], undefined, [], "sender@test.com");
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
  const result = mailbox.capture("alice@test.com", "HTML Email", "<h1>Hello</h1><p>World</p>", true);
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
  const result = mailbox.capture(["a@test.com", "b@test.com", "c@test.com"], "Multi", "To multiple");
  assert("capture with 3 recipients", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("all recipients preserved", msg !== null && msg!.to.length === 3);
}
cleanup();

// --- Default from ---
console.log("\n--- Default From ---");

setup();
{
  const result = mailbox.capture("alice@test.com", "No From", "Test");
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

  mailbox.capture("a@test.com", "1", "1");
  const c1 = mailbox.count();
  // capture stores in both inbox and outbox, so total = inbox + outbox = 2
  assert("count.inbox is 1 after 1 capture", c1.inbox === 1);
  assert("count.outbox is 1 after 1 capture", c1.outbox === 1);
  assert("count.total is 2 after 1 capture (inbox+outbox)", c1.total === 2);

  mailbox.capture("b@test.com", "2", "2");
  mailbox.capture("c@test.com", "3", "3");
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
    mailbox.capture(`u${i}@test.com`, `Msg ${i}`, `Body ${i}`);
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
  mailbox.capture("persist@test.com", "Persist", "Data");

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
  const result = mailbox.capture("a@test.com", "", "");
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
  const result = mailbox.capture("a@test.com", longSubject, longBody);
  assert("long content capture succeeds", result.success === true);

  const msg = mailbox.read(result.id!);
  assert("long subject preserved", msg !== null && msg!.subject.length === 500);
  assert("long body preserved", msg !== null && msg!.body.length === 10000);
}
cleanup();

// --- Non-ASCII round trip ---
console.log("\n--- Non-ASCII Round Trip ---");

// Regression (#262 parity with the Python test_dev_mailbox::test_non_ascii_round_trips
// and the Ruby dev_mailbox UTF-8 fix): non-ASCII subjects/bodies (accented fake-data
// names, smart quotes, euro sign) must survive a capture -> inbox -> read -> count
// round-trip via real on-disk JSON files. Node is the safe case: devMailbox.ts reads
// with readFileSync(path, "utf-8") (UTF-8 pinned, not locale-dependent) and writes via
// JSON.stringify, whose UTF-8 bytes go straight to disk. The locale-decode crash the
// Ruby fix addressed (JSON.pretty_generate writes raw UTF-8 read back under a non-UTF-8
// locale) cannot occur here. This locks in the round-trip + the UTF-8 pin so a future
// change can't silently reintroduce it. Real file I/O, no mocks.
setup();
{
  const subject = "Réservation confirmée — José's café";
  const body = "Dvořák, naïve façade, “smart quotes”, €";

  const result = mailbox.capture("jose@tëst.com", subject, body, false, [], [], undefined, [], "dev@test.com");
  assert("non-ascii capture succeeds", result.success === true);

  // inbox() reads every message file back off disk
  const inbox = mailbox.inbox();
  assert("non-ascii inbox has the captured message", inbox.length === 1);
  assert(
    "non-ascii subject round-trips via inbox()",
    inbox[0].subject === subject,
    `got ${JSON.stringify(inbox[0].subject)}`,
  );

  // read() re-reads then rewrites the file (read receipt) — both directions UTF-8
  const msg = mailbox.read(inbox[0].id);
  assert("non-ascii read() returns the message", msg !== null);
  assert("non-ascii subject round-trips via read()", msg!.subject === subject, `got ${JSON.stringify(msg!.subject)}`);
  assert("non-ascii body round-trips via read()", msg!.body === body, `got ${JSON.stringify(msg!.body)}`);

  // count() walks every file too — must not raise on non-ASCII content
  const c = mailbox.count();
  assert("non-ascii count() returns inbox+outbox totals", c.inbox === 1 && c.outbox === 1 && c.total === 2, JSON.stringify(c));

  // the raw file on disk decodes as UTF-8 and round-trips the EXACT content
  const outboxDir = join(mailboxDir, "outbox");
  const files = readdirSync(outboxDir).filter((f) => f.endsWith(".json"));
  assert("non-ascii outbox has a json file on disk", files.length === 1);
  const onDisk = JSON.parse(readFileSync(join(outboxDir, files[0]), "utf-8"));
  assert(
    "non-ascii content survives the raw on-disk JSON file",
    onDisk.subject === subject && onDisk.body === body,
    JSON.stringify({ subject: onDisk.subject, body: onDisk.body }),
  );
}
cleanup();

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
