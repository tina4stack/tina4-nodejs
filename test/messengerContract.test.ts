/**
 * MESSENGER CONTRACT — the 14 invariants of messenger_contract.json.
 * Run with: npx tsx test/messengerContract.test.ts
 *
 * This is the NAMED suite the shared auditor points at via suites["nodejs"]
 * (tina4-documentation/scripts/audit-contract-fixtures.py). That auditor reads a
 * fixture invariant's `cases` strings and requires each, normalised (lowercased,
 * non-alphanumerics stripped, a leading "test" stripped), to appear as a substring
 * of THIS file. Every one of the 14 tests below therefore carries its invariant id
 * VERBATIM at the head of its title (`msg-...`), so `normalise("msg-uid-is-a-real-uid")`
 * -> "msguidisarealuid" is a literal substring of this file and the auditor matches
 * it in Node exactly as it matches the sibling suites in python/php/ruby. Fixture +
 * ADRs: tina4-documentation/plan/v3/fixtures/messenger_contract.json (ADR-0004),
 * decisions/ADR-0042.md (uid), parity-3.13.96-decisions.md (G1-G11).
 *
 * TWO PROOF CLASSES, NO MOCKS EVER:
 *   - server-free (run everywhere): a genuinely CLOSED real port for the fail-loud
 *     path, a real temp directory for capture, the real getImapEncryption() getter,
 *     and plain method introspection. #6, #10, #11, #13, #14.
 *   - GreenMail (real SMTP 3025 / IMAP 3143 round-trips): #1, #2, #3, #4, #5, #7,
 *     #8, #9, #12. When GreenMail is unreachable these print a SKIP line naming the
 *     unavailable service ("greenmail ... not reachable") so test/_serviceGate.ts
 *     turns them RED under TINA4_REQUIRE_SERVICES (CI provisions GreenMail) and the
 *     lab runs them for real — they NEVER degrade into a hand-rolled fake server
 *     (that was deleted from messenger.test.ts as a double). Override the endpoints
 *     with TINA4_TEST_SMTP_* / TINA4_TEST_IMAP_* (the Python master's names).
 *
 * #8 (msg-read-item-shape) — READ THIS BEFORE "FIXING" THE BODY FIELD NAMES.
 *   Node's read() returns bodyText/bodyHtml. That is Node's OWN idiomatic casing of
 *   the master's body_text/body_html, and it is the SETTLED decision, not a
 *   divergence: parity-3.13.96-decisions.md G5 — "each framework uses ITS OWN
 *   idiomatic casing of the same concept names — body_text/body_html in
 *   python/php/ruby, bodyText/bodyHtml in node" — resting on ADR-0008 ("a property
 *   name keeps its idiomatic spelling; no framework rewrites it silently"). The
 *   CONCEPT set matches the master; only the spelling is idiomatic. So this test
 *   asserts the concept-parity key set with Node's camelCase, and does NOT rename to
 *   snake_case. A rename would be a breaking wire-contract change that contradicts a
 *   dated ADR — a maintainer decision, not a test fix.
 *
 * The original nodejs#41 / #42 four-point contract (factory returns one sender,
 * text is the 5th positional, cc/bcc normalise, interception is a branch) is
 * retained below the 14 invariants — it still gates and overlaps #11 and #14.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessenger,
  Messenger,
  MessengerConnectionError,
} from "../packages/core/src/index.js";
import type { SendResult } from "../packages/core/src/index.js";

let pass = 0;
let fail = 0;
let skipped = 0;

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    // MUST await: an async body that returned a pending promise to a sync check()
    // would count as a pass without ever asserting — worse than no test.
    await fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${(err as Error).message}`);
    fail++;
  }
}

/** A SKIP that the require-services gate can see: keep a service keyword + an
 *  "not reachable" hint in `reason` (test/_serviceGate.ts). */
function skip(name: string, reason: string): void {
  console.log(`  \x1b[33mSKIP\x1b[0m ${name} — ${reason}`);
  skipped++;
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Server-free primitives ───────────────────────────────────────────────────

/** A port that is definitely CLOSED: bind to :0, capture the port, close it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Run `fn` with env vars set, restore them (and any temp dir) afterwards. */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Fresh mailbox dir; dev-capture path active (no SMTP host). */
async function withMailbox<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-mailbox-"));
  const saved = {
    dir: process.env.TINA4_MAILBOX_DIR,
    host: process.env.TINA4_MAIL_HOST,
    debug: process.env.TINA4_DEBUG,
    env: process.env.NODE_ENV,
    capture: process.env.TINA4_MAIL_CAPTURE,
  };
  process.env.TINA4_MAILBOX_DIR = dir;
  process.env.TINA4_DEBUG = "true";
  delete process.env.TINA4_MAIL_HOST; // no SMTP -> the dev path, as on any dev box
  delete process.env.NODE_ENV;
  delete process.env.TINA4_MAIL_CAPTURE;
  try {
    return await fn(dir);
  } finally {
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    restore("TINA4_MAILBOX_DIR", saved.dir);
    restore("TINA4_MAIL_HOST", saved.host);
    restore("TINA4_DEBUG", saved.debug);
    restore("NODE_ENV", saved.env);
    restore("TINA4_MAIL_CAPTURE", saved.capture);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every .json captured under a mailbox dir (recursive). */
function capturedFiles(dir: string): string[] {
  const outbox = join(dir, "outbox");
  try {
    return readdirSync(outbox).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** The single captured message, read back off disk. */
function readCaptured(dir: string): Record<string, unknown> {
  const files = capturedFiles(dir);
  assert(files.length === 1, `expected exactly 1 captured message, found ${files.length}`);
  return JSON.parse(readFileSync(join(dir, "outbox", files[0]), "utf-8"));
}

// ── GreenMail primitives (real SMTP 3025 / IMAP 3143) ────────────────────────

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

/** A unique recipient -> an isolated, first-access-created GreenMail mailbox. */
function recipient(): string {
  return `node-contract-${randomBytes(8).toString("hex")}@tina4.test`;
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

/** Deliver over real SMTP then poll the real IMAP INBOX until it lands. */
async function deliverAndWait(
  m: Messenger,
  to: string,
  subject: string,
  body: string,
  html = false,
): Promise<{ uid: string; subject: string }> {
  const result: SendResult = await m.send(to, subject, body, html);
  if (!result.success) throw new Error(`SMTP send failed: ${result.message}`);
  for (let i = 0; i < 40; i++) {
    const messages = await m.inbox();
    const hit = messages.find((msg) => msg.subject === subject);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`message '${subject}' never arrived in the real IMAP mailbox`);
}

/**
 * A minimal real IMAP client for ground truth, independent of the framework — it
 * speaks IMAP to the same GreenMail so it can state what the server actually holds
 * (needed by #1 to expunge as a second client and read back the real UIDs).
 */
async function withRawImap<T>(
  address: string,
  fn: (raw: (cmd: string) => Promise<string>) => Promise<T>,
): Promise<T> {
  const socket = net.connect({ host: IMAP_HOST, port: IMAP_PORT });
  await new Promise<void>((res, rej) => {
    socket.once("connect", () => res());
    socket.once("error", rej);
  });
  let buffer = "";
  socket.on("data", (d) => {
    buffer += d.toString("utf8");
  });
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
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log("\n=== MESSENGER CONTRACT — 14 invariants (messenger_contract.json) ===\n");

  const greenmailUp =
    (await reachable(SMTP_HOST, SMTP_PORT)) && (await reachable(IMAP_HOST, IMAP_PORT));
  const gmDown = `greenmail SMTP/IMAP not reachable at ${SMTP_HOST}:${SMTP_PORT} / ${IMAP_HOST}:${IMAP_PORT}`;

  // ── #1 msg-uid-is-a-real-uid ────────────────────────────────────────────────
  // The uid is the IMAP UID, not a sequence number. Only a real expunge by ANOTHER
  // client separates the two numberings; before it they are identical, which is why
  // this survived every prior suite. Node was fixed in c1b28fd (UID SEARCH/FETCH/STORE).
  {
    const t = "msg-uid-is-a-real-uid: inbox() returns the real IMAP UID, surviving another client's expunge";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subjects = [0, 1, 2].map((i) => `uid${i}-${randomBytes(4).toString("hex")}`);
        for (const subject of subjects) await deliverAndWait(m, addr, subject, `body of ${subject}`);

        // Second, independent IMAP client expunges message 1 and supplies ground truth.
        const truth = await withRawImap(addr, async (raw) => {
          await raw(`STORE 1 +FLAGS (\\Deleted)`);
          await raw("EXPUNGE");
          const searchResp = await raw("UID SEARCH ALL");
          const uids = (searchResp.match(/^\* SEARCH ([\d ]+)/m)?.[1] ?? "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const bySubject: Record<string, string> = {};
          for (const u of uids) {
            const fetched = await raw(`UID FETCH ${u} (BODY.PEEK[HEADER.FIELDS (SUBJECT)])`);
            const subj = fetched.match(/^Subject:\s*(.+)$/im)?.[1]?.trim();
            if (subj) bySubject[subj] = u;
          }
          return bySubject;
        });

        const survivors = subjects.slice(1).filter((s) => s in truth);
        assert(survivors.length === 2, `expunge fixture broke: ${JSON.stringify(truth)}`);
        // The instrument must be able to fail: the expunge must have shifted the UIDs
        // above the sequence numbers, or nothing below discriminates.
        assert(
          Math.min(...survivors.map((s) => Number(truth[s]))) === 2,
          `expunge did not shift UIDs, cannot discriminate: ${JSON.stringify(truth)}`,
        );

        const reported = new Map((await m.inbox()).map((i) => [i.subject, String(i.uid)]));
        for (const subject of survivors) {
          assert(
            reported.get(subject) === truth[subject],
            `uid for ${subject}: framework reported ${JSON.stringify(reported.get(subject))}, ` +
              `real UID is ${truth[subject]} (a sequence number would be one lower)`,
          );
        }
      });
  }

  // ── #2 msg-uid-is-a-string ──────────────────────────────────────────────────
  {
    const t = "msg-uid-is-a-string: uid is a string on inbox() items and on read()";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `uidstr-${randomBytes(4).toString("hex")}`;
        const env = await deliverAndWait(m, addr, subject, "uid must be a string");
        assert(typeof env.uid === "string", `inbox() uid is ${typeof env.uid}, expected string`);
        const full = await m.read(env.uid);
        assert(full !== null, "read() returned null for a delivered message");
        assert(typeof full!.uid === "string", `read() uid is ${typeof full!.uid}, expected string`);
      });
  }

  // ── #3 msg-inbox-is-newest-first ────────────────────────────────────────────
  {
    const t = "msg-inbox-is-newest-first: inbox() and search() return the page newest-first, inbox(1) is the NEWEST";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subjects = [0, 1, 2].map((i) => `order${i}-${randomBytes(4).toString("hex")}`);
        for (const s of subjects) await deliverAndWait(m, addr, s, `body ${s}`);

        const page = await m.inbox();
        assert(
          page[0].subject === subjects[2],
          `inbox()[0] should be the NEWEST (${subjects[2]}), got ${page[0].subject}`,
        );
        assert(
          page[page.length - 1].subject === subjects[0],
          `inbox() last should be the OLDEST (${subjects[0]}), got ${page[page.length - 1].subject}`,
        );
        const one = await m.inbox("INBOX", 1);
        assert(
          one.length === 1 && one[0].subject === subjects[2],
          `inbox(1) must return the single NEWEST message, got ${JSON.stringify(one.map((x) => x.subject))}`,
        );
      });
  }

  // ── #4 msg-folder-is-first-and-positional ───────────────────────────────────
  // inbox(folder, limit, offset) and read(uid, folder) callable POSITIONALLY. A
  // real server discriminates arg0-is-folder: a wrong-slotted folder would SELECT
  // the wrong (or no) mailbox rather than return the delivered message.
  {
    const t = "msg-folder-is-first-and-positional: inbox(folder, limit, offset) and read(uid, folder) are positional";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `positional-${randomBytes(4).toString("hex")}`;
        const env = await deliverAndWait(m, addr, subject, "positional args");

        // folder FIRST, positionally.
        const listed = await m.inbox("INBOX", 10, 0);
        assert(
          listed.some((i) => i.subject === subject),
          `inbox("INBOX", 10, 0) did not find the message — folder is not arg 0`,
        );
        // read(uid, folder) positionally.
        const full = await m.read(env.uid, "INBOX");
        assert(full !== null && full.subject === subject, `read(uid, "INBOX") failed positionally`);

        // arg0 really is the folder: a bad folder name SELECTs nothing and fails loud.
        let raised: unknown = null;
        try {
          await m.inbox(`NO.SUCH.FOLDER.${randomBytes(4).toString("hex")}`);
        } catch (e) {
          raised = e;
        }
        assert(
          raised instanceof MessengerConnectionError,
          `inbox(<bad folder>) should raise (proving arg0 is the folder), got ${raised === null ? "no throw" : String(raised)}`,
        );
      });
  }

  // ── #5 msg-missing-uid-is-null-not-empty ────────────────────────────────────
  {
    const t = "msg-missing-uid-is-null-not-empty: read() of a non-existent uid returns null and never throws";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const m = messengerFor(recipient()); // fresh, genuinely empty mailbox
        let raised: unknown = null;
        let result: unknown = "unset";
        try {
          result = await m.read("999999");
        } catch (e) {
          raised = e;
        }
        assert(raised === null, `read(<missing>) threw instead of returning null: ${String(raised)}`);
        assert(
          result === null,
          `read(<missing>) must be null (falsy, matching python {}, php null, ruby nil), got ${JSON.stringify(result)}`,
        );
      });
  }

  // ── #6 msg-read-methods-fail-loud (server-free) ─────────────────────────────
  await check(
    "msg-read-methods-fail-loud: inbox/read/unread/search/folders raise MessengerConnectionError on a closed port; send() returns",
    async () => {
      const port = await closedPort();
      const m = new Messenger({
        imapHost: "127.0.0.1",
        imapPort: port,
        imapEncryption: "none",
        imapUser: "u",
        imapPass: "p",
      });
      const readers: Array<[string, () => Promise<unknown>]> = [
        ["inbox", () => m.inbox()],
        ["read", () => m.read("1")],
        ["unread", () => m.unread()],
        ["search", () => m.search()],
        ["folders", () => m.folders()],
      ];
      for (const [nm, call] of readers) {
        let raised: unknown = null;
        try {
          await call();
        } catch (e) {
          raised = e;
        }
        assert(
          raised instanceof MessengerConnectionError,
          `${nm}() must RAISE MessengerConnectionError on a closed port (empty != failure), got ${raised === null ? "no throw" : String(raised)}`,
        );
      }
      // send() is the opposite: it RETURNS a failure result, it never raises.
      const sm = new Messenger({ host: "127.0.0.1", port, encryption: "none", fromAddress: "s@t.test" });
      let sendRaised: unknown = null;
      let sendResult: unknown = null;
      try {
        sendResult = await sm.send("to@t.test", "S", "b");
      } catch (e) {
        sendRaised = e;
      }
      assert(sendRaised === null, `send() must not raise on a connection failure, it threw ${String(sendRaised)}`);
      assert(
        sendResult !== null && (sendResult as SendResult).success === false,
        `send() must return a failure result, got ${JSON.stringify(sendResult)}`,
      );
    },
  );

  // ── #7 msg-inbox-item-shape ─────────────────────────────────────────────────
  {
    const t = "msg-inbox-item-shape: an inbox() item is exactly {uid, subject, from, to, date, snippet, seen} with ISO-8601 date";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `shape-${randomBytes(4).toString("hex")}`;
        await deliverAndWait(m, addr, subject, "shape body");
        const item = (await m.inbox()).find((i) => i.subject === subject)!;
        assert(item !== undefined, "delivered message not listed");

        const keys = Object.keys(item).sort();
        assert(
          JSON.stringify(keys) ===
            JSON.stringify(["date", "from", "seen", "snippet", "subject", "to", "uid"]),
          `inbox item keys must be exactly {uid,subject,from,to,date,snippet,seen}, got ${JSON.stringify(keys)}`,
        );
        assert(typeof item.from === "string", `from must be a string, got ${typeof item.from}`);
        assert(typeof item.to === "string", `to must be a STRING (not an array of {name,email}), got ${typeof item.to}`);
        assert(typeof item.seen === "boolean", `seen must be a boolean, got ${typeof item.seen}`);
        assert(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(item.date) && Number.isFinite(Date.parse(item.date)),
          `date must be ISO-8601, got ${JSON.stringify(item.date)}`,
        );
      });
  }

  // ── #8 msg-read-item-shape ──────────────────────────────────────────────────
  // Concept-parity with the master's {uid,subject,from,to,cc,date,body_*,attachments,
  // headers}, in Node's OWN idiomatic camelCase (bodyText/bodyHtml) per the SETTLED
  // decision parity-3.13.96-decisions.md G5 + ADR-0008. This asserts the concept set,
  // NOT snake_case. Renaming to body_text/body_html is a breaking wire change that
  // contradicts a dated ADR — see the file header.
  {
    const t = "msg-read-item-shape: read() carries the master's field set incl attachments + headers, bodies in idiomatic bodyText/bodyHtml";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `readshape-${randomBytes(4).toString("hex")}`;
        const marker = randomBytes(4).toString("hex");
        const env = await deliverAndWait(m, addr, subject, `body ${marker}`);
        const full = await m.read(env.uid);
        assert(full !== null, "read() returned null for a delivered message");

        const keys = Object.keys(full!).sort();
        assert(
          JSON.stringify(keys) ===
            JSON.stringify([
              "attachments",
              "bodyHtml",
              "bodyText",
              "cc",
              "date",
              "from",
              "headers",
              "subject",
              "to",
              "uid",
            ]),
          `read() keys must be the concept-parity set with idiomatic camelCase bodies, got ${JSON.stringify(keys)}`,
        );
        // The two the fixture calls out: attachments (an ARRAY) and headers (an OBJECT).
        assert(Array.isArray(full!.attachments), `attachments must be an array, got ${typeof full!.attachments}`);
        assert(
          full!.headers !== null && typeof full!.headers === "object" && !Array.isArray(full!.headers),
          `headers must be an object, got ${typeof full!.headers}`,
        );
        // The concept: a decoded plain-text body under Node's idiomatic key.
        assert("bodyText" in full! && "bodyHtml" in full!, "read() must carry bodyText and bodyHtml");
        assert(
          full!.bodyText.includes(marker),
          `bodyText must be the decoded body, got ${JSON.stringify(full!.bodyText)}`,
        );
      });
  }

  // ── #8b msg-read-item-shape / #69: attachments carry the DECODED BYTES ───────
  // A message WITH a real file attachment, sent over real SMTP and read back over
  // real IMAP. The framework base64-encodes the part on send; read() must decode
  // it back to the EXACT original bytes (raw Buffer, not base64) — the same
  // convention as req.files[x].content — and report size as that decoded byte
  // length. Random BINARY content is used so a lossy text round-trip cannot pass.
  {
    const t =
      "msg-read-item-shape read-attachments-carry-decoded-bytes: read() attachment has filename/contentType/size AND content = the exact original bytes";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const dir = mkdtempSync(join(tmpdir(), "tina4-attach-"));
        try {
          const fileName = `payload-${randomBytes(4).toString("hex")}.bin`;
          const filePath = join(dir, fileName);
          const originalBytes = randomBytes(2048); // arbitrary BINARY, not text
          writeFileSync(filePath, originalBytes);

          const addr = recipient();
          const m = messengerFor(addr);
          const subject = `attachbytes-${randomBytes(4).toString("hex")}`;
          // attachments is the 9th positional arg to send().
          const sent: SendResult = await m.send(
            addr, subject, "see attachment", false,
            undefined, undefined, undefined, undefined, [filePath],
          );
          assert(sent.success === true, `send with an attachment failed: ${JSON.stringify(sent)}`);

          let full: Awaited<ReturnType<Messenger["read"]>> = null;
          for (let i = 0; i < 40; i++) {
            const hit = (await m.inbox()).find((x) => x.subject === subject);
            if (hit) {
              full = await m.read(hit.uid);
              break;
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          assert(full !== null, "attachment message never arrived / read() returned null");

          const att = full!.attachments.find((a) => a.filename === fileName);
          assert(
            att !== undefined,
            `attachment '${fileName}' not listed: ${JSON.stringify(full!.attachments.map((a) => a.filename))}`,
          );
          assert(
            att!.contentType === "application/octet-stream",
            `contentType must be application/octet-stream (as sent), got ${JSON.stringify(att!.contentType)}`,
          );
          // content is the RAW DECODED BYTES (a Buffer), same convention as req.files[x].content.
          assert(Buffer.isBuffer(att!.content), `attachment.content must be a Buffer, got ${typeof att!.content}`);
          assert(
            Buffer.compare(att!.content, originalBytes) === 0,
            `attachment.content must equal the original bytes (got ${att!.content.length} bytes vs ${originalBytes.length})`,
          );
          // size is the DECODED byte length, never the base64 length.
          assert(
            att!.size === originalBytes.length,
            `size must be the decoded byte length ${originalBytes.length}, got ${att!.size}`,
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
  }

  // ── #8c msg-read-item-shape: read() carries EXACTLY the 10 canonical keys ─────
  // Canonical set {uid, subject, from, to, cc, date, bodyText, bodyHtml,
  // attachments, headers} — no strays (ADR-0042). #8 asserts the set on a plain
  // message; this pins the COUNT explicitly, so a stray top-level key (e.g. the
  // decoded bytes leaking out of `attachments`) turns it red.
  {
    const t =
      "msg-read-item-shape read-item-shape-is-exactly-ten-keys: read() has EXACTLY the 10 canonical keys, no strays";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `tenkeys-${randomBytes(4).toString("hex")}`;
        const env = await deliverAndWait(m, addr, subject, "exactly ten canonical keys");
        const full = await m.read(env.uid);
        assert(full !== null, "read() returned null for a delivered message");

        const keys = Object.keys(full!).sort();
        const canonical = [
          "attachments", "bodyHtml", "bodyText", "cc", "date",
          "from", "headers", "subject", "to", "uid",
        ].sort();
        assert(
          keys.length === 10,
          `read() must have EXACTLY 10 keys, got ${keys.length}: ${JSON.stringify(keys)}`,
        );
        assert(
          JSON.stringify(keys) === JSON.stringify(canonical),
          `read() key set must be EXACTLY the 10 canonical keys, got ${JSON.stringify(keys)}`,
        );
      });
  }

  // ── #9 msg-snippet-is-decoded-text ──────────────────────────────────────────
  {
    const t = "msg-snippet-is-decoded-text: snippet is decoded, tag-stripped body text (never empty, never base64)";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        // Plain body: the snippet is populated with the real decoded text.
        const addr = recipient();
        const m = messengerFor(addr);
        const subject = `snip-${randomBytes(4).toString("hex")}`;
        const marker = `mk-${randomBytes(6).toString("hex")}`;
        await deliverAndWait(m, addr, subject, `hello ${marker} readable preview`);
        const item = (await m.inbox()).find((i) => i.subject === subject)!;
        assert(
          typeof item.snippet === "string" && item.snippet.length > 0,
          `snippet must be populated (it used to be "" always), got ${JSON.stringify(item.snippet)}`,
        );
        assert(item.snippet.includes(marker), `snippet must contain the decoded body, got ${JSON.stringify(item.snippet)}`);

        // HTML body: the snippet is the TAG-STRIPPED text, never raw markup / base64.
        const addr2 = recipient();
        const m2 = messengerFor(addr2);
        const subject2 = `sniphtml-${randomBytes(4).toString("hex")}`;
        const marker2 = `hm-${randomBytes(6).toString("hex")}`;
        await deliverAndWait(m2, addr2, subject2, `<div><p>Hi <b>${marker2}</b></p></div>`, true);
        const item2 = (await m2.inbox()).find((i) => i.subject === subject2)!;
        assert(
          item2.snippet.includes(marker2) && !item2.snippet.includes("<b>"),
          `html snippet must be decoded + tag-stripped, got ${JSON.stringify(item2.snippet)}`,
        );
        assert(item2.snippet.length <= 200, `snippet must be truncated to <=200 chars, got ${item2.snippet.length}`);
      });
  }

  // ── #10 msg-send-result-shape (server-free) ─────────────────────────────────
  await check(
    "msg-send-result-shape: send() returns {success, message, id} on both paths; id is a real Message-ID on success, null on failure",
    async () => {
      const keysOf = (r: SendResult) => Object.keys(r).sort();
      const expected = JSON.stringify(["id", "message", "success"]);

      // Capture path (no host) -> success with a real id.
      await withMailbox(async () => {
        const r = await new Messenger({ fromAddress: "s@t.test" }).send("to@t.test", "Subj", "body");
        assert(r.success === true, `capture send should succeed, got ${JSON.stringify(r)}`);
        assert(JSON.stringify(keysOf(r)) === expected, `capture keys must be {success,message,id}, got ${keysOf(r)}`);
        assert(typeof r.id === "string" && r.id.length > 0, `success id must be a real id, got ${JSON.stringify(r.id)}`);
      });

      // Failure path 1: no recipients (SMTP branch, host configured).
      const noRcpt = await new Messenger({
        host: "127.0.0.1",
        port: 25,
        encryption: "none",
        fromAddress: "s@t.test",
      }).send([], "Subj", "body");
      assert(noRcpt.success === false, `expected failure, got ${JSON.stringify(noRcpt)}`);
      assert(JSON.stringify(keysOf(noRcpt)) === expected, `failure keys must include id, got ${keysOf(noRcpt)}`);
      assert("id" in noRcpt && noRcpt.id === null, `id must be null on failure (not omitted), got ${JSON.stringify(noRcpt)}`);

      // Failure path 2: a genuinely closed SMTP port.
      const port = await closedPort();
      const refused = await new Messenger({
        host: "127.0.0.1",
        port,
        encryption: "none",
        fromAddress: "s@t.test",
      }).send("to@t.test", "Subj", "body");
      assert(refused.success === false, `expected failure, got ${JSON.stringify(refused)}`);
      assert("id" in refused && refused.id === null, `id must be null on the SMTP-error path, got ${JSON.stringify(refused)}`);
    },
  );

  // ── #11 msg-every-method-exists-everywhere (server-free) ────────────────────
  await check(
    "msg-every-method-exists-everywhere: inbox/read/unread/search/folders/send/sendTemplate/markRead/markUnread/delete all exist and delete is the one name",
    async () => {
      const m = new Messenger({ host: "127.0.0.1", encryption: "none" });
      const required = [
        "inbox",
        "read",
        "unread",
        "search",
        "folders",
        "send",
        "sendTemplate",
        "markRead",
        "markUnread",
        "delete",
      ];
      for (const nm of required) {
        assert(typeof (m as unknown as Record<string, unknown>)[nm] === "function", `Messenger has no ${nm}()`);
      }
      // `delete` is the contract name; `deleteMessage` is a deprecated alias that
      // must DELEGATE to the same IMAP path, not be a hollow no-op. No-mock proof:
      // on a closed port BOTH throw; a stub that quietly returned would not.
      const port = await closedPort();
      const dm = new Messenger({
        imapHost: "127.0.0.1",
        imapPort: port,
        imapEncryption: "none",
        imapUser: "u",
        imapPass: "p",
      });
      let deleteThrew = false;
      let aliasThrew = false;
      try {
        await dm.delete("1");
      } catch {
        deleteThrew = true;
      }
      try {
        await (dm as unknown as { deleteMessage: (u: string) => Promise<void> }).deleteMessage("1");
      } catch {
        aliasThrew = true;
      }
      assert(deleteThrew, "delete() must reach the real IMAP path (throw on a closed port)");
      assert(aliasThrew, "deleteMessage() must delegate to delete() (throw on a closed port), not no-op");
    },
  );

  // ── #12 msg-env-vars-are-honoured-everywhere ────────────────────────────────
  // The IMAP-specific creds must be READ and WIN over the SMTP ones. GreenMail keys
  // the mailbox off the LOGIN username, so if IMAP auth used TINA4_MAIL_USERNAME
  // instead of TINA4_MAIL_IMAP_USERNAME it would read the WRONG (empty) mailbox.
  // (Node is the reference for this rule; this test names both env vars literally.)
  {
    const t = "msg-env-vars-are-honoured-everywhere: TINA4_MAIL_IMAP_USERNAME/_PASSWORD are read and win over TINA4_MAIL_USERNAME/_PASSWORD";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const imapBox = recipient(); // where the message is delivered + must be read
        const smtpUser = recipient(); // a DIFFERENT account set as TINA4_MAIL_USERNAME
        const subject = `imapcreds-${randomBytes(4).toString("hex")}`;
        await deliverAndWait(messengerFor(imapBox), imapBox, subject, "read via IMAP creds");

        await withEnv(
          {
            TINA4_MAIL_HOST: SMTP_HOST,
            TINA4_MAIL_PORT: String(SMTP_PORT),
            TINA4_MAIL_ENCRYPTION: "none",
            TINA4_MAIL_IMAP_HOST: IMAP_HOST,
            TINA4_MAIL_IMAP_PORT: String(IMAP_PORT),
            TINA4_MAIL_IMAP_ENCRYPTION: "none",
            TINA4_MAIL_USERNAME: smtpUser, // the SMTP account (must NOT be used for IMAP)
            TINA4_MAIL_PASSWORD: "secret",
            TINA4_MAIL_IMAP_USERNAME: imapBox, // the IMAP account (must win)
            TINA4_MAIL_IMAP_PASSWORD: "secret",
          },
          async () => {
            const envMessenger = new Messenger(); // pure env-driven
            const found = (await envMessenger.inbox()).some((i) => i.subject === subject);
            assert(
              found === true,
              `inbox() authenticated with TINA4_MAIL_USERNAME (${smtpUser}) instead of ` +
                `TINA4_MAIL_IMAP_USERNAME (${imapBox}) — IMAP-specific creds were ignored`,
            );
          },
        );
      });
  }

  // ── #13 msg-explicit-beats-env (server-free) ────────────────────────────────
  // getImapEncryption() is the observable proof: env is READ, and an explicit
  // constructor value WINS over it (ADR-0041 precedence; G9 added the ctor param).
  await check(
    "msg-explicit-beats-env: a constructor imapEncryption beats TINA4_MAIL_IMAP_ENCRYPTION, which beats the default",
    async () => {
      await withEnv({ TINA4_MAIL_IMAP_ENCRYPTION: "starttls" }, () => {
        // env is genuinely READ (not ignored) ...
        assert(
          new Messenger().getImapEncryption() === "starttls",
          `env TINA4_MAIL_IMAP_ENCRYPTION should be read, got ${new Messenger().getImapEncryption()}`,
        );
        // ... and an explicit constructor value WINS over it.
        assert(
          new Messenger({ imapEncryption: "none" }).getImapEncryption() === "none",
          `constructor imapEncryption must beat the env var, got ${new Messenger({ imapEncryption: "none" }).getImapEncryption()}`,
        );
      });
      // With neither set, the documented default holds.
      await withEnv({ TINA4_MAIL_IMAP_ENCRYPTION: undefined }, () => {
        assert(
          new Messenger().getImapEncryption() === "tls",
          `default imap encryption should be "tls", got ${new Messenger().getImapEncryption()}`,
        );
      });
    },
  );

  // ── #14 msg-capture-gate (server-free) ──────────────────────────────────────
  await check(
    "msg-capture-gate: capture with no SMTP host, send with one; TINA4_DEBUG does not suppress; TINA4_MAIL_CAPTURE forces capture; one concrete type",
    async () => {
      // (a) No SMTP host -> capture (sending is impossible, so simulate to disk).
      await withMailbox(async (dir) => {
        const r = await new Messenger({ fromAddress: "s@t.test" }).send("to@t.test", "S", "b");
        assert(r.success === true, `no-host send should capture+succeed, got ${JSON.stringify(r)}`);
        assert(capturedFiles(dir).length === 1, "no-host send must write one captured message");
      });

      // (b) SMTP host configured (closed port) -> SEND, do NOT capture. Proven by a
      //     failure result AND nothing written to the mailbox dir.
      const port = await closedPort();
      await withEnv(
        { TINA4_MAIL_CAPTURE: undefined, TINA4_DEBUG: "true" },
        async () => {
          const dir = mkdtempSync(join(tmpdir(), "tina4-mailbox-"));
          await withEnv({ TINA4_MAILBOX_DIR: dir }, async () => {
            // TINA4_DEBUG is truthy AND a host is configured: debug must NOT suppress sending.
            const r = await new Messenger({
              host: "127.0.0.1",
              port,
              encryption: "none",
              fromAddress: "s@t.test",
            }).send("to@t.test", "S", "b");
            assert(r.success === false, `configured host must SEND (and fail on a closed port), got ${JSON.stringify(r)}`);
            assert(
              capturedFiles(dir).length === 0,
              "a configured host with TINA4_DEBUG on must NOT capture — debug does not suppress sending",
            );
          });
          rmSync(dir, { recursive: true, force: true });
        },
      );

      // (c) TINA4_MAIL_CAPTURE=true forces capture even with a host configured.
      {
        const dir = mkdtempSync(join(tmpdir(), "tina4-mailbox-"));
        await withEnv({ TINA4_MAIL_CAPTURE: "true", TINA4_MAILBOX_DIR: dir }, async () => {
          const r = await new Messenger({
            host: "127.0.0.1",
            port: 25,
            encryption: "none",
            fromAddress: "s@t.test",
          }).send("to@t.test", "S", "b");
          assert(r.success === true, `TINA4_MAIL_CAPTURE=true must force capture success, got ${JSON.stringify(r)}`);
          assert(capturedFiles(dir).length === 1, "forced capture must write one message, hitting no network");
        });
        rmSync(dir, { recursive: true, force: true });
      }

      // (d) ONE concrete type, interception is a branch inside send(), never a swap.
      await withMailbox(() => {
        const mail = createMessenger();
        assert(mail instanceof Messenger, `createMessenger() must return a Messenger, got ${mail.constructor.name}`);
        assert(
          (mail as unknown as { send: unknown }).send === (Messenger.prototype as unknown as { send: unknown }).send,
          "the returned object's send must be Messenger.prototype.send — interception is a branch, not a method swap",
        );
        assert(
          !Object.prototype.hasOwnProperty.call(mail, "send"),
          "send must not be an own instance property (that would be a swap)",
        );
      });
    },
  );

  // ═══ Original nodejs#41 / #42 four-point contract (retained; overlaps #11/#14) ═══
  console.log("\n-- nodejs#41 / #42 (factory, text-5th-positional, cc/bcc normalise, interception) --");

  type Sender = { send: (...a: unknown[]) => unknown };

  await check("+ createMessenger() returns something with a callable send()", async () => {
    await withMailbox(() => {
      const mail = createMessenger();
      assert(
        typeof (mail as Partial<Sender>).send === "function",
        `createMessenger() returned ${mail.constructor.name} whose send is ${typeof (mail as Partial<Sender>).send}`,
      );
    });
  });

  await check("- createMessenger() never returns a capture-only object", async () => {
    await withMailbox(() => {
      const mail = createMessenger() as Partial<Sender> & { capture?: unknown };
      const captureOnly = typeof mail.capture === "function" && typeof mail.send !== "function";
      assert(!captureOnly, `createMessenger() returned a capture-only object — that is nodejs#41`);
    });
  });

  await check("+ a captured message round-trips text (text is the 5th positional)", async () => {
    await withMailbox(async (dir) => {
      const mail = createMessenger() as Sender;
      await mail.send("a@b.com", "Subj", "<p>body</p>", true, "the text part");
      const msg = readCaptured(dir);
      assert("text" in msg, "EmailMessage has no text field — the captured message is not what would be sent");
      assert(msg.text === "the text part", `text round-trip failed: ${JSON.stringify(msg.text)}`);
    });
  });

  await check("- the plain-text body is never stored as a cc recipient (nodejs#42)", async () => {
    await withMailbox(async (dir) => {
      const mail = createMessenger() as Sender;
      await mail.send("a@b.com", "Subject", "<p>hi</p>", true, "plain text alternative");
      const msg = readCaptured(dir);
      const cc = Array.isArray(msg.cc) ? msg.cc : msg.cc === undefined ? [] : [msg.cc];
      assert(!cc.includes("plain text alternative"), `plain-text body filed as CC: cc=${JSON.stringify(msg.cc)}`);
    });
  });

  await check("+ a proper cc list passes through unchanged", async () => {
    await withMailbox(async (dir) => {
      const mail = createMessenger() as Sender;
      await mail.send("a@b.com", "S", "<p>b</p>", true, undefined, ["x@y.com", "p@q.com"]);
      const msg = readCaptured(dir);
      assert(
        JSON.stringify(msg.cc) === JSON.stringify(["x@y.com", "p@q.com"]),
        `a valid cc list was altered: ${JSON.stringify(msg.cc)}`,
      );
    });
  });

  await check("- a bare-string cc is normalised to a list, not stored as a bare string", async () => {
    await withMailbox(async (dir) => {
      const mail = createMessenger() as Sender;
      await mail.send("a@b.com", "Subject", "<p>hi</p>", true, undefined, "one@cc.com");
      const msg = readCaptured(dir);
      assert(typeof msg.cc !== "string", `cc stored as a bare string: ${JSON.stringify(msg.cc)}`);
      assert(JSON.stringify(msg.cc) === JSON.stringify(["one@cc.com"]), `cc not normalised: ${JSON.stringify(msg.cc)}`);
    });
  });

  await check("+ interception is a branch: the object's send is the class's send", async () => {
    await withMailbox(() => {
      const mail = createMessenger() as Partial<Sender>;
      assert(
        mail.send === (Messenger.prototype as unknown as Sender).send,
        `the returned object's send is not Messenger.prototype.send (got ${(mail as object).constructor.name})`,
      );
    });
  });

  await check("- send is not an own property, and the type is Messenger", async () => {
    await withMailbox(() => {
      const mail = createMessenger();
      assert(!Object.prototype.hasOwnProperty.call(mail, "send"), "send is an own property — interception is a swap");
      assert(mail instanceof Messenger, `createMessenger() returned ${mail.constructor.name}, not a Messenger`);
    });
  });

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m` +
      `, \x1b[33m${skipped} skipped\x1b[0m`,
  );
  console.log(`${"=".repeat(60)}\n`);

  process.exit(fail > 0 ? 1 : 0);
}

await main();
