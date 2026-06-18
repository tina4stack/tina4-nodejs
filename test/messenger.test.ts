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

const result = mailbox.capture("alice@test.com", "Hello", "Hi there!");

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
assert("createMessenger returns DevMailbox when no TINA4_MAIL_HOST", devMsngr instanceof DevMailbox);

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
  // not production → DevMailbox (and importantly, no ReferenceError).
  process.env.TINA4_MAIL_HOST = "smtp.example.com";
  delete process.env.TINA4_DEBUG;
  process.env.NODE_ENV = "development";
  let threw = false;
  let inst: unknown = null;
  try { inst = createMessenger(); } catch { threw = true; }
  assert("createMessenger does not throw on isProd path", threw === false);
  assert("createMessenger returns DevMailbox when not production", inst instanceof DevMailbox);

  // Production + SMTP host → real Messenger (still no throw).
  process.env.NODE_ENV = "production";
  let prodInst: unknown = null;
  let prodThrew = false;
  try { prodInst = createMessenger(); } catch { prodThrew = true; }
  assert("createMessenger does not throw in production", prodThrew === false);
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

  // --- M1: protocol failure (NO/BAD) raises, empty mailbox returns empty ---
  console.log("\n--- IMAP fail-loud + empty-mailbox (M1) ---");

  // Tiny fake IMAP server: speaks just enough to drive the client. `mode`
  // controls the SELECT/SEARCH/FETCH behaviour for each scenario.
  function fakeImapServer(mode: "empty" | "protocolFail" | "missingUid"): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => {
        socket.write("* OK fake IMAP ready\r\n");
        socket.on("data", (chunk) => {
          const text = chunk.toString("utf-8");
          // The client tags each command (e.g. "T5 SELECT ...").
          const tagMatch = text.match(/^(T\d+)\s+(\w+)/);
          if (!tagMatch) return;
          const [, tag, cmd] = tagMatch;
          const c = cmd.toUpperCase();

          if (c === "LOGIN") { socket.write(`${tag} OK LOGIN completed\r\n`); return; }
          if (c === "LOGOUT") { socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); return; }

          if (c === "SELECT") {
            if (mode === "protocolFail") { socket.write(`${tag} NO mailbox unavailable\r\n`); return; }
            socket.write(`* 0 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
            return;
          }
          if (c === "SEARCH") {
            // Empty result set — successful, just no UIDs.
            socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
            return;
          }
          if (c === "FETCH") {
            // Missing UID: tagged OK, no message body literal.
            socket.write(`${tag} OK FETCH completed\r\n`);
            return;
          }
          if (c === "STORE") { socket.write(`${tag} OK STORE completed\r\n`); return; }
          socket.write(`${tag} OK\r\n`);
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({ port, close: () => server.close() });
      });
    });
  }

  // protocolFail: SELECT returns NO → must RAISE (not return []).
  {
    const srv = await fakeImapServer("protocolFail");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: srv.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    await assertAsync("inbox() RAISES on IMAP NO protocol error", async () => {
      try { await m.inbox(); return false; }
      catch (e) { return e instanceof MessengerConnectionError; }
    });
    srv.close();
  }

  // empty: successful SELECT + empty SEARCH → returns [] / 0 (NOT an error).
  {
    const srv = await fakeImapServer("empty");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: srv.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    await assertAsync("inbox() empty mailbox returns []", async () => {
      const r = await m.inbox();
      return Array.isArray(r) && r.length === 0;
    });
    await assertAsync("unread() with no unseen returns 0", async () => {
      const r = await m.unread();
      return r === 0;
    });
    await assertAsync("search() with no matches returns []", async () => {
      const r = await m.search();
      return Array.isArray(r) && r.length === 0;
    });
    srv.close();
  }

  // missingUid: successful FETCH for a non-existent UID → returns empty message (not error).
  {
    const srv = await fakeImapServer("missingUid");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: srv.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    await assertAsync("read() of missing UID returns empty message", async () => {
      const r = await m.read("999");
      return r.uid === "999" && r.subject === "" && r.bodyText === "" && r.bodyHtml === "";
    });
    srv.close();
  }

  // Cleanup
  cleanup();

  // Summary
  console.log(`\n${"=".repeat(50)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(fail > 0 ? 1 : 0);
})();
