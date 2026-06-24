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

// ── Real local TCP servers (NOT mocks) ───────────────────────
// These are real listening sockets created with node:net. The Messenger
// connects to them over a real TCP socket and speaks the real SMTP/IMAP
// wire protocol; the servers RECORD what the client actually sent so the
// tests can assert on the protocol traffic the real Messenger produced.

interface FakeImap {
  port: number;
  close: () => void;
  /** Every full command line the client wrote (tag + command). */
  commands: string[];
}

/**
 * Tiny real IMAP server. `mode` controls SELECT/SEARCH/FETCH behaviour; the
 * server records every command line it receives so a test can assert the
 * Messenger emitted e.g. `STORE <uid> +FLAGS (\Seen)`.
 */
function fakeImapServer(
  mode: "empty" | "protocolFail" | "missingUid" | "loginOk" | "oneMessage",
): Promise<FakeImap> {
  return new Promise((resolve) => {
    const commands: string[] = [];
    const server = net.createServer((socket) => {
      socket.write("* OK fake IMAP ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        for (const rawLine of text.split("\r\n")) {
          if (!rawLine) continue;
          const tagMatch = rawLine.match(/^(T\d+)\s+(\w+)/);
          if (!tagMatch) continue;
          commands.push(rawLine);
          const [, tag, cmd] = tagMatch;
          const c = cmd.toUpperCase();

          if (c === "LOGIN") { socket.write(`${tag} OK LOGIN completed\r\n`); continue; }
          if (c === "LOGOUT") { socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); continue; }

          if (c === "SELECT") {
            if (mode === "protocolFail") { socket.write(`${tag} NO mailbox unavailable\r\n`); continue; }
            const exists = mode === "oneMessage" ? 1 : 0;
            socket.write(`* ${exists} EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`);
            continue;
          }
          if (c === "SEARCH") {
            if (mode === "oneMessage") { socket.write(`* SEARCH 7\r\n${tag} OK SEARCH completed\r\n`); continue; }
            // Empty result set — successful, just no UIDs.
            socket.write(`* SEARCH\r\n${tag} OK SEARCH completed\r\n`);
            continue;
          }
          if (c === "FETCH") {
            if (mode === "oneMessage") {
              // A header FETCH for the summary list.
              const header = "From: bob@test.com\r\nTo: alice@test.com\r\nSubject: Greetings\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000\r\n";
              socket.write(`* 7 FETCH (FLAGS () BODY[HEADER.FIELDS (FROM TO SUBJECT DATE)] {${header.length}}\r\n${header})\r\n${tag} OK FETCH completed\r\n`);
              continue;
            }
            // Missing UID: tagged OK, no message body literal.
            socket.write(`${tag} OK FETCH completed\r\n`);
            continue;
          }
          if (c === "STORE") { socket.write(`${tag} OK STORE completed\r\n`); continue; }
          if (c === "EXPUNGE") { socket.write(`${tag} OK EXPUNGE completed\r\n`); continue; }
          socket.write(`${tag} OK\r\n`);
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close(), commands });
    });
  });
}

interface FakeSmtp {
  port: number;
  close: () => void;
  /** Commands the client sent (MAIL FROM / RCPT TO / DATA / QUIT ...). */
  commands: string[];
  /** The raw DATA payload (the MIME message) the client transmitted (live read). */
  getData: () => string;
}

/**
 * Tiny real SMTP sink. Speaks just enough of SMTP to accept a message and
 * records the envelope + DATA payload so a test can assert the real Messenger
 * sent the RCPT TO + message body for the recipient.
 */
function fakeSmtpServer(): Promise<FakeSmtp> {
  return new Promise((resolve) => {
    const state = { commands: [] as string[], data: "" };
    const server = net.createServer((socket) => {
      let inData = false;
      let dataBuf = "";
      socket.write("220 fake SMTP ready\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf-8");
        if (inData) {
          dataBuf += text;
          // DATA ends with <CRLF>.<CRLF>
          const endIdx = dataBuf.indexOf("\r\n.\r\n");
          if (endIdx !== -1) {
            state.data = dataBuf.substring(0, endIdx);
            inData = false;
            socket.write("250 OK message accepted\r\n");
          }
          return;
        }
        for (const rawLine of text.split("\r\n")) {
          if (!rawLine) continue;
          state.commands.push(rawLine);
          const upper = rawLine.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
            socket.write("250 fake SMTP\r\n");
          } else if (upper.startsWith("MAIL FROM")) {
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("RCPT TO")) {
            socket.write("250 OK\r\n");
          } else if (upper.startsWith("DATA")) {
            inData = true;
            socket.write("354 End data with <CRLF>.<CRLF>\r\n");
          } else if (upper.startsWith("QUIT")) {
            socket.write("221 Bye\r\n");
            socket.end();
          } else {
            socket.write("250 OK\r\n");
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close(), commands: state.commands, getData: () => state.data });
    });
  });
}

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
  // not production → DevMailbox. We now assert the REAL outcome: the returned
  // DevMailbox actually captures a message to its local store WITHOUT touching
  // SMTP (proving the dev branch is a working file-backed mailbox, not just a
  // no-throw / non-null shape).
  process.env.TINA4_MAIL_HOST = "smtp.example.com";
  delete process.env.TINA4_DEBUG;
  process.env.NODE_ENV = "development";
  process.env.TINA4_MAILBOX_DIR = join(TEST_DIR, "factory-dev");
  const inst = createMessenger();
  assert("createMessenger returns DevMailbox when not production", inst instanceof DevMailbox);
  {
    const cap = (inst as DevMailbox).capture("factory@test.com", "FactoryDev", "captured, no SMTP");
    const back = (inst as DevMailbox).read(cap.id!);
    assert(
      "createMessenger dev instance captures to disk without SMTP",
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

  // ── Messenger send + IMAP method behaviour (real local servers) ──
  // These replace the former row of `typeof messenger.X === "function"`
  // existence smoke checks: each now drives the real Messenger socket code
  // against a real local SMTP/IMAP server and asserts the observable result
  // or the protocol traffic the Messenger actually emitted.
  console.log("\n--- Messenger send + IMAP behaviour ---");

  // send(): against a real local SMTP sink the SendResult is success and the
  // server received MAIL FROM / RCPT TO for the recipient + the DATA payload.
  {
    const smtp = await fakeSmtpServer();
    const m = new Messenger({
      host: "127.0.0.1", port: smtp.port, encryption: "none",
      fromAddress: "sender@test.com",
    });
    const r: SendResult = await m.send("alice@test.com", "Hello SMTP", "Body text here");
    assert("send() returns success against real SMTP sink", r.success === true, `\n    got: ${JSON.stringify(r)}`);
    // Let the server finish flushing the DATA buffer before asserting on it.
    await new Promise((res) => setTimeout(res, 50));
    assert("send() emitted MAIL FROM for the sender",
      smtp.commands.some((c) => /^MAIL FROM:<sender@test\.com>/i.test(c)),
      `\n    commands: ${JSON.stringify(smtp.commands)}`);
    assert("send() emitted RCPT TO for the recipient",
      smtp.commands.some((c) => /^RCPT TO:<alice@test\.com>/i.test(c)),
      `\n    commands: ${JSON.stringify(smtp.commands)}`);
    const sentData = smtp.getData();
    assert("send() transmitted the subject + body in DATA",
      sentData.includes("Subject: Hello SMTP") && sentData.includes("Body text here"),
      `\n    data: ${JSON.stringify(sentData)}`);
    smtp.close();
  }

  // testConnection(): false against a refused port, true against the real SMTP
  // server. (Returns a { success, message } object — assert on .success.)
  {
    const refused = await refusedPort();
    const mBad = new Messenger({ host: "127.0.0.1", port: refused, encryption: "none" });
    const bad = await mBad.testConnection();
    assert("testConnection() fails against a refused port", bad.success === false, `\n    got: ${JSON.stringify(bad)}`);

    const smtp = await fakeSmtpServer();
    const mOk = new Messenger({ host: "127.0.0.1", port: smtp.port, encryption: "none" });
    const ok = await mOk.testConnection();
    assert("testConnection() succeeds against the real SMTP server", ok.success === true, `\n    got: ${JSON.stringify(ok)}`);
    smtp.close();
  }

  // testImapConnection(): true against the real IMAP server (login OK), false
  // against a refused port.
  {
    const imap = await fakeImapServer("loginOk");
    const mOk = new Messenger({
      imapHost: "127.0.0.1", imapPort: imap.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const ok = await mOk.testImapConnection();
    assert("testImapConnection() succeeds against real IMAP server", ok.success === true, `\n    got: ${JSON.stringify(ok)}`);
    assert("testImapConnection() actually logged in (LOGIN sent)",
      imap.commands.some((c) => /\bLOGIN\b/i.test(c)), `\n    commands: ${JSON.stringify(imap.commands)}`);
    imap.close();

    const refused = await refusedPort();
    const mBad = new Messenger({
      imapHost: "127.0.0.1", imapPort: refused, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const bad = await mBad.testImapConnection();
    assert("testImapConnection() fails against a refused port", bad.success === false, `\n    got: ${JSON.stringify(bad)}`);
  }

  // inbox(): against a real IMAP server holding one message, returns that
  // message with the parsed subject. (Behaviour, not a typeof check.)
  {
    const imap = await fakeImapServer("oneMessage");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: imap.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const msgs = await m.inbox();
    assert("inbox() returns the message from a non-empty mailbox",
      Array.isArray(msgs) && msgs.length === 1 && msgs[0].uid === "7" && msgs[0].subject === "Greetings",
      `\n    got: ${JSON.stringify(msgs)}`);
    imap.close();
  }

  // search(): against the real IMAP server returns the matched UID.
  {
    const imap = await fakeImapServer("oneMessage");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: imap.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    const found = await m.search("INBOX", "Greetings");
    assert("search() returns the matched UID from the real server",
      Array.isArray(found) && found.length === 1 && found[0].uid === "7",
      `\n    got: ${JSON.stringify(found)}`);
    // The Messenger built the SEARCH with the SUBJECT criterion.
    assert("search() emitted the SUBJECT search criterion",
      imap.commands.some((c) => /SEARCH .*SUBJECT "Greetings"/i.test(c)),
      `\n    commands: ${JSON.stringify(imap.commands)}`);
    imap.close();
  }

  // markRead(): the server receives STORE <uid> +FLAGS (\Seen).
  {
    const imap = await fakeImapServer("loginOk");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: imap.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    await m.markRead("42");
    assert("markRead() sent STORE <uid> +FLAGS (\\Seen)",
      imap.commands.some((c) => /STORE 42 \+FLAGS \(\\Seen\)/.test(c)),
      `\n    commands: ${JSON.stringify(imap.commands)}`);
    imap.close();
  }

  // deleteMessage(): the server receives STORE <uid> +FLAGS (\Deleted) then EXPUNGE.
  {
    const imap = await fakeImapServer("loginOk");
    const m = new Messenger({
      imapHost: "127.0.0.1", imapPort: imap.port, imapUser: "u", imapPass: "p",
      imapEncryption: "none",
    });
    await m.deleteMessage("99");
    const storedDeleted = imap.commands.findIndex((c) => /STORE 99 \+FLAGS \(\\Deleted\)/.test(c));
    const expunged = imap.commands.findIndex((c) => /\bEXPUNGE\b/.test(c));
    assert("deleteMessage() sent STORE +FLAGS (\\Deleted) then EXPUNGE",
      storedDeleted >= 0 && expunged > storedDeleted,
      `\n    commands: ${JSON.stringify(imap.commands)}`);
    imap.close();
  }

  // createMessenger() production branch: the returned Messenger is a WORKING
  // SMTP client built from the configured host:port — point the env at a real
  // local SMTP server and assert createMessenger() yields a Messenger that
  // actually connects there. (Strengthens the former no-throw smoke check.)
  {
    const savedHost = process.env.TINA4_MAIL_HOST;
    const savedPort = process.env.TINA4_MAIL_PORT;
    const savedDebug = process.env.TINA4_DEBUG;
    const savedEnv = process.env.NODE_ENV;
    const savedEnc = process.env.TINA4_MAIL_ENCRYPTION;

    const smtp = await fakeSmtpServer();
    process.env.TINA4_MAIL_HOST = "127.0.0.1";
    process.env.TINA4_MAIL_PORT = String(smtp.port);
    process.env.TINA4_MAIL_ENCRYPTION = "none";
    delete process.env.TINA4_DEBUG;
    process.env.NODE_ENV = "production";

    const prod = createMessenger();
    assert("createMessenger() prod branch yields a real Messenger", prod instanceof Messenger);
    const conn = await (prod as Messenger).testConnection();
    assert("createMessenger() prod Messenger connects to its configured SMTP host",
      conn.success === true, `\n    got: ${JSON.stringify(conn)}`);
    smtp.close();

    if (savedHost === undefined) delete process.env.TINA4_MAIL_HOST; else process.env.TINA4_MAIL_HOST = savedHost;
    if (savedPort === undefined) delete process.env.TINA4_MAIL_PORT; else process.env.TINA4_MAIL_PORT = savedPort;
    if (savedDebug === undefined) delete process.env.TINA4_DEBUG; else process.env.TINA4_DEBUG = savedDebug;
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
    if (savedEnc === undefined) delete process.env.TINA4_MAIL_ENCRYPTION; else process.env.TINA4_MAIL_ENCRYPTION = savedEnc;
  }

  // --- M1: protocol failure (NO/BAD) raises, empty mailbox returns empty ---
  console.log("\n--- IMAP fail-loud + empty-mailbox (M1) ---");

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
