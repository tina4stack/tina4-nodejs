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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
/**
 * A minimal real IMAP client for ground truth, independent of the framework.
 *
 * It stands in for nothing and simulates nothing - it speaks IMAP to the same
 * GreenMail the framework is talking to, so it can state what the server
 * actually holds.
 */
async function withRawImap<T>(address: string, fn: (raw: (cmd: string) => Promise<string>) => Promise<T>): Promise<T> {
  const socket = net.connect({ host: IMAP_HOST, port: IMAP_PORT });
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", rej);
  });
  let buffer = "";
  socket.on("data", (d) => { buffer += d.toString("utf8"); });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(150);

  let seq = 0;
  const raw = async (cmd: string): Promise<string> => {
    const tag = `a${++seq}`;
    buffer = "";
    socket.write(`${tag} ${cmd}\r\n`);
    for (let i = 0; i < 80; i++) {
      if (new RegExp(`^${tag} (OK|NO|BAD)`, "m").test(buffer)) break;
      await wait(50);
    }
    return buffer;
  };

  try {
    await raw(`LOGIN ${address} secret`);
    await raw("SELECT INBOX");
    return await fn(raw);
  } finally {
    try { socket.destroy(); } catch { /* already gone */ }
  }
}

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

  // ── uid is a real IMAP UID, not a sequence number ───────────────────────
  //
  // MEASURED 2026-08-06 against live GreenMail, all four frameworks, one
  // mailbox. Before an expunge the two numberings are IDENTICAL, which is why
  // this survived every existing contract suite:
  //
  //   send P1 P2 P3   by sequence {1:P1,2:P2,3:P3}   by UID {1:P1,2:P2,3:P3}
  //   expunge P1      by sequence {1:P2,2:P3}        by UID {2:P2,3:P3}
  //
  // So P3 is sequence number 2 and UID 3. Node reported "2"; PHP and Ruby
  // reported 3. Node issued SEARCH/FETCH/STORE - the sequence-number commands -
  // rather than UID SEARCH/UID FETCH/UID STORE.
  //
  // A sequence number renumbers whenever ANY client expunges, so an id stored
  // today addresses a different message tomorrow. No error, just the wrong
  // message.
  {
    console.log("\n-- uid survives an expunge by another client --");
    const addr = recipient();
    const m = messengerFor(addr);

    const subjects = [0, 1, 2].map((i) => `uid${i}-${randomBytes(4).toString("hex")}`);
    for (const subject of subjects) {
      await deliverAndWait(m, addr, subject, `body of ${subject}`);
    }

    // A second, independent IMAP client does the expunge and supplies ground
    // truth. It speaks the protocol directly - it stands in for nothing.
    const truth = await withRawImap(addr, async (raw) => {
      await raw(`STORE 1 +FLAGS (\\Deleted)`);
      await raw("EXPUNGE");
      const searchResp = await raw("UID SEARCH ALL");
      const uids = (searchResp.match(/^\* SEARCH ([\d ]+)/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
      const bySubject: Record<string, string> = {};
      for (const u of uids) {
        const fetched = await raw(`UID FETCH ${u} (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
        const subj = fetched.match(/^Subject:\s*(.+)$/mi)?.[1]?.trim();
        if (subj) bySubject[subj] = u;
      }
      return bySubject;
    });

    const survivors = subjects.slice(1).filter((s) => s in truth);
    assert("the expunge fixture built (2 messages survive)", survivors.length === 2,
      `\n    truth: ${JSON.stringify(truth)}`);
    // The instrument must be able to fail: if the UIDs still start at 1 the
    // expunge did not shift them and nothing below discriminates.
    assert("the expunge shifted the UIDs, so this can discriminate",
      Math.min(...survivors.map((s) => Number(truth[s]))) === 2,
      `\n    truth: ${JSON.stringify(truth)}`);

    const reported = new Map((await m.inbox()).map((i) => [i.subject, String(i.uid)]));
    for (const subject of survivors) {
      assert(`uid for ${subject} is the real UID, not a sequence number`,
        reported.get(subject) === truth[subject],
        `\n    framework reported ${JSON.stringify(reported.get(subject))}, real UID is ${truth[subject]}`);
    }
  }

  // The pair: switching to UID commands must not break the ordinary path.
  {
    console.log("\n-- a uid still reads the message it names --");
    const addr = recipient();
    const m = messengerFor(addr);
    const subject = `uidread-${randomBytes(4).toString("hex")}`;
    const hit = await deliverAndWait(m, addr, subject, "read me by uid");
    const full = await m.read(hit.uid);
    assert("read(uid) returns the message that uid names",
      full !== null && full.subject === subject,
      `\n    read(${JSON.stringify(hit.uid)}) -> ${JSON.stringify(full && full.subject)}`);
  }

  // ── G3: snippet is decoded, tag-stripped plain text (never "" , never base64) ──
  {
    console.log("\n-- G3: inbox() snippet is real decoded text --");
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node Snippet ${randomBytes(4).toString("hex")}`;
    const marker = `snip-${randomBytes(6).toString("hex")}`;
    const body = `hello ${marker} this is the readable preview text`;

    const envelope = await deliverAndWait(m, to, subject, body);
    const listed = (await m.inbox()).find((i) => i.subject === subject)!;
    assert("snippet is populated, not the empty string it always was",
      typeof listed.snippet === "string" && listed.snippet.length > 0,
      `\n    snippet: ${JSON.stringify(listed?.snippet)}`);
    assert("snippet contains the decoded body text",
      listed.snippet.includes(marker),
      `\n    snippet: ${JSON.stringify(listed.snippet)}`);

    // An HTML send: the snippet must be the TAG-STRIPPED text, never raw markup
    // and never base64 gibberish.
    const to2 = recipient();
    const m2 = messengerFor(to2);
    const subject2 = `Node SnippetHtml ${randomBytes(4).toString("hex")}`;
    const marker2 = `htmlsnip-${randomBytes(6).toString("hex")}`;
    await deliverAndWait(m2, to2, subject2, `<div><p>Hi <b>${marker2}</b></p></div>`, true);
    const listed2 = (await m2.inbox()).find((i) => i.subject === subject2)!;
    assert("html snippet is decoded and tag-stripped (has the text, no <b>)",
      listed2.snippet.includes(marker2) && !listed2.snippet.includes("<b>"),
      `\n    snippet: ${JSON.stringify(listed2.snippet)}`);
    assert("snippet is truncated to at most 200 chars", listed2.snippet.length <= 200);
  }

  // ── G4: one inbox() item shape — exactly 7 keys, date is ISO-8601 ──────────────
  {
    console.log("\n-- G4: inbox() item shape + ISO-8601 date --");
    const to = recipient();
    const m = messengerFor(to);
    const subject = `Node Shape ${randomBytes(4).toString("hex")}`;
    await deliverAndWait(m, to, subject, "shape body");
    const item = (await m.inbox()).find((i) => i.subject === subject)!;

    const keys = Object.keys(item).sort();
    assert("inbox item has EXACTLY {uid, subject, from, to, date, snippet, seen}",
      JSON.stringify(keys) === JSON.stringify(["date", "from", "seen", "snippet", "subject", "to", "uid"]),
      `\n    keys: ${JSON.stringify(keys)}`);
    assert("uid is a string", typeof item.uid === "string");
    assert("to is a string (not an array of {name,email})", typeof item.to === "string");
    assert("seen is a boolean", typeof item.seen === "boolean");
    // ISO-8601: parses to a finite instant AND matches the ISO shape (not the raw
    // RFC-2822 "Wed, 06 Aug 2026 22:00:00 GMT" only Python used to normalise).
    assert("date is ISO-8601",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(item.date) && Number.isFinite(Date.parse(item.date)),
      `\n    date: ${JSON.stringify(item.date)}`);
  }

  // ── G5: read() returns an attachments array; a real attachment is listed ──────
  {
    console.log("\n-- G5: read() attachments --");
    const to = recipient();
    const m = messengerFor(to);

    // A plain message: attachments is an empty ARRAY (the field must EXIST).
    const plainSubj = `Node NoAttach ${randomBytes(4).toString("hex")}`;
    const plain = await deliverAndWait(m, to, plainSubj, "no attachments here");
    const plainFull = await m.read(plain.uid);
    assert("read() carries an attachments array (empty when none)",
      Array.isArray(plainFull!.attachments) && plainFull!.attachments.length === 0,
      `\n    attachments: ${JSON.stringify(plainFull!.attachments)}`);

    // A message WITH a real file attachment, sent through the real SMTP path.
    const dir = mkdtempSync(join(tmpdir(), "tina4-attach-"));
    try {
      const fileName = `note-${randomBytes(4).toString("hex")}.txt`;
      const filePath = join(dir, fileName);
      const fileBody = `attachment payload ${randomBytes(8).toString("hex")}`;
      writeFileSync(filePath, fileBody, "utf-8");

      const to2 = recipient();
      const m2 = messengerFor(to2);
      const subj2 = `Node Attach ${randomBytes(4).toString("hex")}`;
      const sent: SendResult = await m2.send(
        to2, subj2, "see attachment", false, undefined, undefined, undefined, undefined, [filePath],
      );
      assert("send() with an attachment succeeds", sent.success === true, `\n    ${JSON.stringify(sent)}`);

      let full: Awaited<ReturnType<Messenger["read"]>> = null;
      for (let i = 0; i < 40; i++) {
        const hit = (await m2.inbox()).find((x) => x.subject === subj2);
        if (hit) { full = await m2.read(hit.uid); break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert("the attachment message arrived", full !== null, "\n    never arrived");
      assert("read() lists the attachment with its filename",
        full!.attachments.some((a) => a.filename === fileName),
        `\n    attachments: ${JSON.stringify(full!.attachments)}`);
      assert("the listed attachment carries a positive size",
        full!.attachments.every((a) => typeof a.size === "number" && a.size > 0),
        `\n    attachments: ${JSON.stringify(full!.attachments)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── G8: TINA4_MAIL_IMAP_USERNAME/_PASSWORD are read and WIN over the SMTP one ──
  //
  // Node is the reference for this rule. GreenMail (auth disabled) keys the
  // mailbox off the LOGIN username, so if IMAP auth used TINA4_MAIL_USERNAME
  // instead of TINA4_MAIL_IMAP_USERNAME it would read the WRONG (empty) mailbox.
  {
    console.log("\n-- G8: IMAP-specific credentials are honoured --");
    const imapBox = recipient();     // where the message is actually delivered + read
    const smtpUser = recipient();    // a DIFFERENT account, set as TINA4_MAIL_USERNAME
    const subject = `Node ImapCreds ${randomBytes(4).toString("hex")}`;

    // Deliver to imapBox using a constructor Messenger (no env involved).
    await deliverAndWait(messengerFor(imapBox), imapBox, subject, "read via IMAP creds");

    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };
    setEnv("TINA4_MAIL_HOST", SMTP_HOST);
    setEnv("TINA4_MAIL_PORT", String(SMTP_PORT));
    setEnv("TINA4_MAIL_ENCRYPTION", "none");
    setEnv("TINA4_MAIL_IMAP_HOST", IMAP_HOST);
    setEnv("TINA4_MAIL_IMAP_PORT", String(IMAP_PORT));
    setEnv("TINA4_MAIL_IMAP_ENCRYPTION", "none");
    setEnv("TINA4_MAIL_USERNAME", smtpUser);          // the SMTP account
    setEnv("TINA4_MAIL_PASSWORD", "secret");
    setEnv("TINA4_MAIL_IMAP_USERNAME", imapBox);      // the IMAP account (must win)
    setEnv("TINA4_MAIL_IMAP_PASSWORD", "secret");
    try {
      const envMessenger = new Messenger();            // pure env-driven
      const found = (await envMessenger.inbox()).some((i) => i.subject === subject);
      assert("inbox() authenticates with TINA4_MAIL_IMAP_USERNAME, not TINA4_MAIL_USERNAME",
        found === true,
        `\n    read the '${smtpUser}' mailbox instead of '${imapBox}' — IMAP-specific creds were ignored`);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  }

  console.log(`\n${"=".repeat(52)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(52)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
