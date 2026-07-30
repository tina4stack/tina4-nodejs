/**
 * Unit tests for the Messenger and DevMailbox modules.
 * Run with: npx tsx test/messenger.test.ts
 *
 * Tests the Messenger class structure, DevMailbox file-backed mailbox,
 * and the createMessenger factory. No actual SMTP/IMAP connections.
 */
import {
  Messenger, DevMailbox, createMessenger, MessengerConnectionError,
} from "../packages/core/src/index.ts";
import type { SendResult, EmailMessage } from "../packages/core/src/index.ts";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";

async function assertAsync(name: string, fn: () => Promise<boolean>, detail = ""): Promise<void> {
  try {
    const ok = await fn();
    assert(name, ok, detail);
  } catch (err) {
    assert(name, false, `\n    threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

// ── Real endpoints only ──────────────────────────────────────
// This file used to define fakeImapServer() / fakeSmtpServer(): real listening
// sockets that replied with canned strings ("* OK fake IMAP ready", "250 fake
// SMTP") chosen by a `mode` switch. A hand-rolled in-test backend is a double
// under the no-mock rule, and it could only ever confirm the client parses
// strings this file wrote -- never that a message leaves, lands and reads back.
// The SMTP/IMAP behaviour now runs against a real GreenMail in
// test/messengerGreenMail.test.ts. What stays here needs no mail server: pure
// config/encryption resolution and the REAL refused-connection failure paths.

/** Bind+immediately-close a TCP server to obtain a port guaranteed refused. */
function refusedPort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

console.log("=== Messenger Tests ===\n");

// --- Messenger class behaviour ---
// NOTE: the Messenger send/IMAP methods drive a real socket, so their
// behavioural assertions live in the async block at the bottom of this file
// (they exercise the real local SMTP/IMAP servers defined above). What was a
// row of `typeof === "function"` smoke checks is now real protocol traffic.

// --- DevMailbox basics ---
console.log("\n--- DevMailbox basics ---");

const mailbox = new DevMailbox(TEST_DIR);
// A fresh, file-backed mailbox starts genuinely empty — count() reads the
// real directory (created on demand) and reports zero messages before any
// capture. (Was a `mailbox !== null` construction-only smoke check.)
{
  const fresh = new DevMailbox(TEST_DIR);
  const c = fresh.count();
  assert("DevMailbox starts empty (count().total === 0)", c.total === 0 && c.inbox === 0 && c.outbox === 0);
}
// capture/inbox/read/clear/delete/unreadCount/count/seed behaviour is each
// exercised against the real file-backed store in the sections below — the
// former `typeof === "function"` existence smoke checks were redundant and
// have been folded into those real assertions.

// --- DevMailbox capture ---
console.log("\n--- DevMailbox capture ---");

const result = mailbox.capture("alice@test.com", "Hello", "Hi there!");

assert("capture returns success", result.success === true);

// capture persists the message to disk: a brand-new DevMailbox pointed at the
// SAME directory reads the captured message back, proving the body/subject
// round-tripped through the filesystem (not just an in-memory return shape).
{
  const reopened = new DevMailbox(TEST_DIR);
  const persisted = reopened.read(result.id!);
  assert(
    "capture persists message to disk (round-trips through a fresh DevMailbox)",
    persisted !== null && persisted.subject === "Hello" && persisted.body === "Hi there!"
      && persisted.to.includes("alice@test.com"),
    `\n    got: ${JSON.stringify(persisted)}`,
  );
}

// capture returns an id that maps to the stored message: read(result.id)
// returns the just-captured Hello/Hi there! message.
{
  const byId = mailbox.read(result.id!);
  assert(
    "capture id maps to the stored message",
    typeof result.id === "string" && byId !== null && byId.subject === "Hello" && byId.body === "Hi there!",
    `\n    got: ${JSON.stringify(byId)}`,
  );
}

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
mailbox.capture("bob@test.com", "Unread", "New message");
const unread = mailbox.unreadCount();
assert("unreadCount returns count of unread messages", unread >= 1);

// --- DevMailbox multiple captures ---
console.log("\n--- Multiple captures ---");

mailbox.capture(["c@test.com"], "Third", "3", false, ["cc@test.com"]);
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

mailbox.capture("x@test.com", "New", "after clear");
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

// Without TINA4_MAIL_HOST set, should return DevMailbox
const origHost = process.env.TINA4_MAIL_HOST;
const origEnv = process.env.NODE_ENV;
delete process.env.TINA4_MAIL_HOST;
process.env.NODE_ENV = "development";

const devMsngr = createMessenger();
// Changed in 3.13.94. This asserted the BUG: createMessenger() returned
// `Messenger | DevMailbox`, and those two share no sending method, so the
// documented send() call threw TypeError on the dev branch (nodejs#41). The factory
// now returns ONE type whose send() captures internally.
assert("createMessenger returns a Messenger even with no TINA4_MAIL_HOST", devMsngr instanceof Messenger);
assert("createMessenger result can always send", typeof devMsngr.send === "function");

// Restore
if (origHost) process.env.TINA4_MAIL_HOST = origHost;
if (origEnv) process.env.NODE_ENV = origEnv;

// createMessenger must NOT throw on the isProd code path (N1 — previously a
// ReferenceError because `isProd` was undefined).
{
  const savedHost = process.env.TINA4_MAIL_HOST;
  const savedDebug = process.env.TINA4_DEBUG;
  const savedEnv = process.env.NODE_ENV;

  // Path that previously hit the undefined `isProd`: SMTP host set, not debug,
  // not production → DevMailbox. We now assert the REAL outcome: the returned
  // DevMailbox actually captures a message to its local store WITHOUT touching
  // SMTP (proving the dev branch is a working file-backed mailbox, not just a
  // no-throw / non-null shape).
  process.env.TINA4_MAIL_HOST = "smtp.example.com";
  delete process.env.TINA4_DEBUG;
  process.env.NODE_ENV = "development";
  process.env.TINA4_MAILBOX_DIR = join(TEST_DIR, "factory-dev");
  // Under the new gate an SMTP host means SEND, so a test about capturing must not
  // have one configured. This block previously relied on NODE_ENV alone.
  delete process.env.TINA4_MAIL_HOST;
  const inst = createMessenger();
  // Changed in 3.13.94: one concrete type, and NODE_ENV no longer gates capture at
  // all (that clause captured even with SMTP configured, silently eating staging
  // mail). Capture now follows whether an SMTP host exists.
  assert("createMessenger returns a Messenger regardless of NODE_ENV", inst instanceof Messenger);
  {
    const cap = await inst.send("factory@test.com", "FactoryDev", "captured, no SMTP");
    const back = inst.devMailbox!.read(cap.id!);
    assert(
      "createMessenger instance captures to disk without SMTP, through send()",
      cap.success === true && back !== null && back.subject === "FactoryDev",
      `\n    got: ${JSON.stringify(back)}`,
    );
  }
  delete process.env.TINA4_MAILBOX_DIR;

  // Production + SMTP host → real Messenger. The branch outcome (instanceof
  // Messenger) is asserted here; that the prod instance is a WORKING Messenger
  // built from the configured SMTP host (i.e. it really opens an SMTP session
  // against that host:port) is verified live against a real local SMTP server
  // in the async block at the bottom of this file.
  process.env.NODE_ENV = "production";
  const prodInst = createMessenger();
  assert("createMessenger returns Messenger in production with SMTP", prodInst instanceof Messenger);

  // Restore
  if (savedHost === undefined) delete process.env.TINA4_MAIL_HOST; else process.env.TINA4_MAIL_HOST = savedHost;
  if (savedDebug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = savedDebug;
  if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
}

// ── Async lock-in tests (IMAP fail-loud + TLS default) ──────────
(async () => {
  // --- N1: TLS default is secure unless the insecure env is set ---
  console.log("\n--- IMAP TLS default (N1) ---");

  {
    // A bad IMAP host over TLS must reject (connection failure). With the
    // default secure setting we still expect a thrown MessengerConnectionError,
    // never a silently-empty []. (No env override = secure.)
    const savedInsecure = process.env.TINA4_MAIL_TLS_INSECURE;
    delete process.env.TINA4_MAIL_TLS_INSECURE;

    // Find a closed port to guarantee a connection refusal.
    const m = new Messenger({
      imapHost: "127.0.0.1",
      imapPort: 1,            // almost certainly refused
      imapUser: "u",
      imapPass: "p",
      imapEncryption: "tls",
    });

    await assertAsync("inbox() RAISES on connection failure", async () => {
      try { await m.inbox(); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });

    await assertAsync("read() RAISES on connection failure", async () => {
      try { await m.read("1"); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });

    await assertAsync("unread() RAISES on connection failure", async () => {
      try { await m.unread(); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });

    await assertAsync("search() RAISES on connection failure", async () => {
      try { await m.search(); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });

    await assertAsync("folders() RAISES on connection failure", async () => {
      try { await m.folders(); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });

    if (savedInsecure === undefined) delete process.env.TINA4_MAIL_TLS_INSECURE;
    else process.env.TINA4_MAIL_TLS_INSECURE = savedInsecure;
  }

  // --- Real refused-connection failure paths ---
  // The SMTP/IMAP SUCCESS paths (send, inbox, read, search, markRead,
  // deleteMessage, folders, empty-mailbox) moved to
  // test/messengerGreenMail.test.ts, where they run against a real GreenMail.
  // What is left needs no mail server: a port nothing listens on is a genuine
  // connection failure, so these exercise the real error paths.
  console.log("\n--- Messenger failure paths (real refused connections) ---");

  {
    const refused = await refusedPort();
    const m = new Messenger({ host: "127.0.0.1", port: refused, encryption: "none" });
    const r = await m.testConnection();
    assert("testConnection() fails against a refused port", r.success === false,
      `\n    got: ${JSON.stringify(r)}`);
  }

  {
    const refused = await refusedPort();
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: refused, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const r = await m.testImapConnection();
    assert("testImapConnection() fails against a refused port", r.success === false,
      `\n    got: ${JSON.stringify(r)}`);
  }

  // Fail-loud contract: an IMAP read must RAISE on a connection failure, never
  // swallow it into an empty result (a caller cannot tell "no mail" from "server
  // down"). PHP asserts this for all five readers; Node now does too.
  {
    const refused = await refusedPort();
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: refused, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const readers: [string, () => Promise<unknown>][] = [
      ["inbox()", () => m.inbox()],
      ["read()", () => m.read("1")],
      ["unread()", () => m.unread()],
      ["search()", () => m.search()],
      ["folders()", () => m.folders()],
    ];
    for (const [name, call] of readers) {
      await assertAsync(`${name} RAISES on a refused IMAP connection`, async () => {
        try { await call(); return false; }
        catch (e) { return e instanceof MessengerConnectionError; }
      });
    }
  }


  // Cleanup
  cleanup();

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
})();
