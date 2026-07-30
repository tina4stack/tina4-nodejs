/**
 * Messenger SMTP + IMAP against a REAL GreenMail server.
 *
 * Parity with the Python master (tests/test_messenger.py), Ruby
 * (spec/messenger_spec.rb) and PHP (tests/MessengerImapGreenMailTest.php).
 *
 * This replaces the hand-rolled `fakeSmtpServer()` / `fakeImapServer()` in
 * messenger.test.ts. Those were real SOCKETS but not a real mail server: they
 * replied with canned strings ("* OK fake IMAP ready", "250 fake SMTP") and a
 * mode switch chose which canned answer to give. A hand-rolled in-test backend
 * is a double under the no-mock rule, and it could only ever confirm that the
 * client parses strings the test itself wrote — never that a message actually
 * leaves, lands, and reads back.
 *
 * The old tests asserted on the CLIENT'S traffic (e.g. that `STORE 42 +FLAGS
 * (\Seen)` was written to the socket). Against a real server the client's
 * commands are not observable, so these assert the OBSERVABLE OUTCOME instead —
 * that the message really is marked read, really is deleted. That is the
 * stronger claim: emitting the right bytes is only a proxy for the server
 * having acted on them.
 *
 * GreenMail runs with -Dgreenmail.auth.disabled, so a mailbox is created on
 * first access. Each test uses a UNIQUE random recipient and therefore gets an
 * isolated, genuinely-empty mailbox — which is what makes the empty-mailbox
 * assertions real rather than incidental.
 *
 * Ports are GreenMail's PLAIN (non-TLS) 3025 / 3143. Override via
 * TINA4_TEST_SMTP_HOST / _PORT and TINA4_TEST_IMAP_HOST / _PORT (the Python
 * master's names).
 *
 * Run with: npx tsx test/messengerGreenMail.test.ts
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import {
  Messenger,
  MessengerConnectionError,
  createMessenger,
} from "../packages/core/src/messenger.js";
import type { SendResult } from "../packages/core/src/messenger.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const SMTP_HOST = process.env.TINA4_TEST_SMTP_HOST || "127.0.0.1";
const SMTP_PORT = Number(process.env.TINA4_TEST_SMTP_PORT || 3025);
const IMAP_HOST = process.env.TINA4_TEST_IMAP_HOST || "127.0.0.1";
const IMAP_PORT = Number(process.env.TINA4_TEST_IMAP_PORT || 3143);

/** Real TCP reachability probe — no double, just a connect. */
function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/** A unique recipient -> an isolated, first-access-created mailbox. */
function recipient(): string {
  return `node-${randomBytes(8).toString("hex")}@tina4.test`;
}

function messengerFor(address: string): Messenger {
  return new Messenger({
    host: SMTP_HOST,
    port: SMTP_PORT,
    encryption: "none",
    fromAddress: "sender@tina4.test",
    fromName: "Sender",
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    imapUser: address,
    imapPass: "secret",
    imapEncryption: "none",
  });
}

/**
 * Deliver over real SMTP then poll the real IMAP INBOX until it lands.
 *
 * Delivery is asynchronous from the sender's point of view, so a single
 * immediate read would be a race.
 */
async function deliverAndWait(
  m: Messenger,
  to: string,
  subject: string,
  body: string,
  html = false,
): Promise<{ uid: string; subject: string }> {
  const result: SendResult = await m.send(to, subject, body, html);
  if (!result.success) {
    throw new Error(`SMTP send failed: ${result.message}`);
  }
  for (let i = 0; i < 40; i++) {
    const messages = await m.inbox();
    const hit = messages.find((msg) => msg.subject === subject);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`message '${subject}' never arrived in the real IMAP mailbox`);
}

async function main(): Promise<void> {
  console.log("=== Messenger vs REAL GreenMail (SMTP 3025 / IMAP 3143) ===\n");

  const smtpUp = await reachable(SMTP_HOST, SMTP_PORT);
  const imapUp = await reachable(IMAP_HOST, IMAP_PORT);
  if (!smtpUp || !imapUp) {
    // Wording matters: the TINA4_REQUIRE_SERVICES gate in test/_serviceGate.ts
    // scans SKIP lines for a provisioned-service keyword, so in CI (where
    // GreenMail IS provisioned) this becomes a hard failure instead of green.
    console.log(
      `  \x1b[33mSKIP\x1b[0m Messenger GreenMail round-trip — greenmail SMTP/IMAP not reachable at `
      + `${SMTP_HOST}:${SMTP_PORT} / ${IMAP_HOST}:${IMAP_PORT}`,
    );
    process.exit(0);
  }

  // ── Real SMTP -> real IMAP round trip ──────────────────────────────
  {
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node RoundTrip ${randomBytes(4).toString("hex")}`;
    const body = `plain body ${randomBytes(4).toString("hex")}`;

    const envelope = await deliverAndWait(m, to, subject, body);
    assert("send() delivers and inbox() reads the envelope back", envelope.subject === subject,
      `\n    got: ${JSON.stringify(envelope)}`);

    const full = await m.read(envelope.uid);
    assert("read() returns the body that was actually sent",
      full.bodyText.includes(body),
      `\n    bodyText: ${JSON.stringify(full.bodyText)}`);
    assert("read() returns the subject", full.subject === subject);
  }

  // An html:true send must land in bodyHtml, not be flattened into text —
  // asserting on the union of both would pass even if the HTML part were lost.
  {
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node HTML ${randomBytes(4).toString("hex")}`;
    const marker = randomBytes(4).toString("hex");

    const envelope = await deliverAndWait(m, to, subject, `<p>hi <b>${marker}</b></p>`, true);
    const full = await m.read(envelope.uid);
    assert("html send round-trips into bodyHtml", full.bodyHtml.includes(marker),
      `\n    bodyHtml: ${JSON.stringify(full.bodyHtml)}`);
    assert("html markup survives (not stripped to text)", full.bodyHtml.includes("<b>"),
      `\n    bodyHtml: ${JSON.stringify(full.bodyHtml)}`);
  }

  // search(): the real server matches on the SUBJECT criterion.
  {
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node Findable ${randomBytes(4).toString("hex")}`;

    await deliverAndWait(m, to, subject, "search for me");
    const hits = await m.search("INBOX", subject);
    assert("search(subject) returns exactly the delivered message",
      hits.length === 1 && hits[0].subject === subject,
      `\n    got: ${JSON.stringify(hits)}`);
  }

  // markRead(): assert the OUTCOME (unread count drops), not the STORE bytes.
  {
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node Unread ${randomBytes(4).toString("hex")}`;

    const envelope = await deliverAndWait(m, to, subject, "unread me");
    assert("unread() counts a freshly delivered message", (await m.unread()) === 1,
      `\n    got: ${await m.unread()}`);

    await m.markRead(envelope.uid);
    assert("markRead() really marks it read on the server", (await m.unread()) === 0,
      `\n    got: ${await m.unread()}`);
  }

  // deleteMessage(): assert the OUTCOME (the message is gone), not the EXPUNGE bytes.
  {
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node Delete ${randomBytes(4).toString("hex")}`;

    const envelope = await deliverAndWait(m, to, subject, "delete me");
    await m.deleteMessage(envelope.uid);

    const remaining = await m.inbox();
    assert("deleteMessage() really removes it from the server",
      !remaining.some((msg) => msg.subject === subject),
      `\n    still present: ${JSON.stringify(remaining)}`);
  }

  // folders(): a real IMAP LIST.
  {
    const to = recipient();
    const m = messengerFor(to);
    await deliverAndWait(m, to, `Node Folders ${randomBytes(4).toString("hex")}`, "x");

    const folders = await m.folders();
    assert("folders() lists INBOX from the real server",
      folders.some((f) => f.toUpperCase().includes("INBOX")),
      `\n    got: ${JSON.stringify(folders)}`);
  }

  // testConnection / testImapConnection against the REAL server.
  {
    const m = messengerFor(recipient());
    assert("testConnection() succeeds against real GreenMail SMTP",
      (await m.testConnection()).success === true);
    assert("testImapConnection() succeeds against real GreenMail IMAP",
      (await m.testImapConnection()).success === true);
  }

  // ── A genuinely EMPTY mailbox is not an error ──────────────────────
  // These are the cases the deleted "empty" / "missingUid" fake modes faked.
  {
    const m = messengerFor(recipient());
    const messages = await m.inbox();
    assert("inbox() on a genuinely empty mailbox returns []",
      Array.isArray(messages) && messages.length === 0,
      `\n    got: ${JSON.stringify(messages)}`);
    assert("unread() on a genuinely empty mailbox returns 0", (await m.unread()) === 0);

    const noHits = await m.search("INBOX", `no-such-subject-${randomBytes(4).toString("hex")}`);
    assert("search() with no matches returns []", noHits.length === 0,
      `\n    got: ${JSON.stringify(noHits)}`);

    // A UID that does not exist on a REAL server. Missing is NOT an error, and
    // the return must be FALSY so `if (!msg)` detects it -- matching Python's
    // {} , PHP's null and Ruby's nil. Node used to return a truthy object here.
    const missing = await m.read("999999");
    assert("read() of a missing UID returns null (falsy), not an error",
      missing === null, `\n    got: ${JSON.stringify(missing)}`);
  }

  // A real protocol-level refusal: SELECT on a mailbox that does not exist.
  // This replaces the deleted "protocolFail" fake mode, which hand-wrote
  // `NO mailbox unavailable`. Here the real server decides.
  {
    const m = messengerFor(recipient());
    let raised: unknown = null;
    try {
      // folder is the FIRST argument (3.13.95 parity with Python/PHP/Ruby).
      await m.inbox("NO.SUCH.FOLDER.aa11bb22");
    } catch (e) {
      raised = e;
    }
    assert("inbox() on a non-existent folder RAISES MessengerConnectionError",
      raised instanceof MessengerConnectionError,
      `\n    got: ${raised === null ? "no throw" : String(raised)}`);
  }

  // createMessenger() production branch: the factory must yield a WORKING SMTP
  // client built from the configured host:port -- point the env at real
  // GreenMail and assert the returned Messenger actually connects there.
  {
    const saved = {
      host: process.env.TINA4_MAIL_HOST,
      port: process.env.TINA4_MAIL_PORT,
      enc: process.env.TINA4_MAIL_ENCRYPTION,
      debug: process.env.TINA4_DEBUG,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.TINA4_MAIL_HOST = SMTP_HOST;
    process.env.TINA4_MAIL_PORT = String(SMTP_PORT);
    process.env.TINA4_MAIL_ENCRYPTION = "none";
    delete process.env.TINA4_DEBUG;
    process.env.NODE_ENV = "production";
    try {
      const prod = createMessenger();
      assert("createMessenger() prod branch yields a real Messenger", prod instanceof Messenger);
      const conn = await prod.testConnection();
      assert("createMessenger() prod Messenger connects to its configured SMTP host",
        conn.success === true, `\n    got: ${JSON.stringify(conn)}`);
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      };
      restore("TINA4_MAIL_HOST", saved.host);
      restore("TINA4_MAIL_PORT", saved.port);
      restore("TINA4_MAIL_ENCRYPTION", saved.enc);
      restore("TINA4_DEBUG", saved.debug);
      restore("NODE_ENV", saved.nodeEnv);
    }
  }

  console.log(`\n${"=".repeat(52)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(52)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
