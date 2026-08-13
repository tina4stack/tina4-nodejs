/**
 * MAIL REDIRECT CONTRACT — TINA4_MAIL_REDIRECT_TO (MAIL-DEC-01).
 * Run with: npx tsx test/mailRedirectContract.test.ts
 *
 * Pins plan/v3/fixtures/mail_redirect_contract.json. TINA4_MAIL_REDIRECT_TO is a
 * SECOND, independent knob on the real-SMTP path: when a redirect list is
 * configured and send() is actually talking to SMTP (not capturing), every
 * recipient is REPLACED by the redirect list and the original recipients are
 * preserved in an X-Tina4-Original-To header. Capture (TINA4_MAIL_CAPTURE / no
 * SMTP host) always wins — redirect never applies on the capture path.
 *
 * Real GreenMail SMTP :3025 / IMAP :3143 (TINA4_TEST_SMTP_* / TINA4_TEST_IMAP_*
 * to relocate — the SAME live server messengerGreenMail.test.ts and
 * messengerContract.test.ts use). NO MOCKS EVER: every case sends real SMTP and
 * proves delivery or non-delivery with a real IMAP fetch. When GreenMail is
 * unreachable these print a SKIP line naming the unavailable service, so
 * test/_serviceGate.ts turns them RED under TINA4_REQUIRE_SERVICES.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Messenger } from "../packages/core/src/index.js";

let pass = 0;
let fail = 0;
let skipped = 0;

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    // MUST await: an async body that returned a pending promise to a sync check()
    // would count as a pass without ever asserting.
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

/** Run `fn` with env vars set, restore them afterwards (undefined -> delete). */
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

/** A unique address -> an isolated, first-access-created GreenMail mailbox
 *  (GreenMail's auth is disabled on this lab, so LOGIN as any never-used
 *  address succeeds and SELECT INBOX reports 0 messages — verified live). */
function uniqueAddr(prefix: string, domain: string): string {
  return `mailredirect-${prefix}-${randomBytes(6).toString("hex")}@${domain}`;
}

/** A messenger wired for a real SMTP send only (no IMAP creds needed). */
function senderMessenger(): Messenger {
  return new Messenger({
    host: SMTP_HOST,
    port: SMTP_PORT,
    encryption: "none",
    fromAddress: "sender@tina4.test",
    fromName: "Sender",
  });
}

/** A messenger wired to poll ONE mailbox's real IMAP. The address IS the
 *  mailbox identity (GreenMail auth disabled — any password is accepted). */
function readerMessenger(address: string): Messenger {
  return new Messenger({
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    imapUser: address,
    imapPass: "secret",
    imapEncryption: "none",
  });
}

/** Poll until `subject` is listed in `address`'s real IMAP inbox; returns the
 *  inbox() item. Fails (throws) if the budget is exhausted. */
async function waitPresent(
  address: string,
  subject: string,
  attempts = 40,
  delayMs = 250,
): Promise<{ uid: string; subject: string }> {
  const reader = readerMessenger(address);
  for (let i = 0; i < attempts; i++) {
    const messages = await reader.inbox();
    const hit = messages.find((m) => m.subject === subject);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`'${subject}' never arrived in ${address}'s real IMAP mailbox`);
}

/** Poll for `subject` to confirm it NEVER arrives within a real bounded window.
 *  Mutation-proof: if the recipient-rewrite is disabled the message DOES land
 *  here and this returns false well before the budget is exhausted. */
async function staysAbsent(
  address: string,
  subject: string,
  attempts = 40,
  delayMs = 250,
): Promise<boolean> {
  const reader = readerMessenger(address);
  for (let i = 0; i < attempts; i++) {
    const messages = await reader.inbox();
    if (messages.some((m) => m.subject === subject)) return false;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return true;
}

// ── Dev capture primitives (real filesystem, TINA4_MAILBOX_DIR) ─────────────

/** Count of .json messages captured to the real DevMailbox outbox on disk. */
function outboxCount(dir: string): number {
  try {
    return readdirSync(join(dir, "outbox")).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  console.log("\n=== MAIL REDIRECT CONTRACT — TINA4_MAIL_REDIRECT_TO (MAIL-DEC-01) ===\n");

  const greenmailUp =
    (await reachable(SMTP_HOST, SMTP_PORT)) && (await reachable(IMAP_HOST, IMAP_PORT));
  const gmDown = `greenmail SMTP/IMAP not reachable at ${SMTP_HOST}:${SMTP_PORT} / ${IMAP_HOST}:${IMAP_PORT}`;

  // ── redirect_delivers_to_every_address_on_the_list ──────────────────────────
  {
    const t =
      "redirect_delivers_to_every_address_on_the_list: TINA4_MAIL_REDIRECT_TO delivers to " +
      "every dev address and NOT the real one, carrying X-Tina4-Original-To";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const dev1 = uniqueAddr("dev1", "x.test");
        const dev2 = uniqueAddr("dev2", "x.test");
        const real = uniqueAddr("real", "y.test");
        const subject = `mailredirect-${randomBytes(4).toString("hex")}`;

        // A deliberate space after the comma proves the parse rule really trims.
        await withEnv({ TINA4_MAIL_REDIRECT_TO: `${dev1}, ${dev2}` }, async () => {
          const sender = senderMessenger();
          const result = await sender.send(real, subject, "the real message body");
          assert(result.success, `send() reported failure: ${result.message}`);

          const item1 = await waitPresent(dev1, subject);
          const item2 = await waitPresent(dev2, subject);
          assert(!!item1 && !!item2, "message not listed for both dev addresses");

          const absent = await staysAbsent(real, subject);
          assert(absent, `the real recipient ${real} received the redirected mail`);

          const full = await readerMessenger(dev1).read(item1.uid);
          assert(full !== null, "read() of the dev1 message returned null");
          const originalTo = full!.headers["x-tina4-original-to"];
          assert(
            originalTo === real,
            `X-Tina4-Original-To was ${JSON.stringify(originalTo)}, expected ${JSON.stringify(real)}`,
          );
        });
      });
  }

  // ── redirect_unset_delivers_normally ─────────────────────────────────────────
  {
    const t =
      "redirect_unset_delivers_normally: with TINA4_MAIL_REDIRECT_TO unset, mail arrives at " +
      "the real recipient (negative/control)";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const real = uniqueAddr("realctrl", "y.test");
        const subject = `mailredirect-ctrl-${randomBytes(4).toString("hex")}`;

        await withEnv({ TINA4_MAIL_REDIRECT_TO: undefined }, async () => {
          const sender = senderMessenger();
          const result = await sender.send(real, subject, "normal delivery");
          assert(result.success, `send() reported failure: ${result.message}`);
          const item = await waitPresent(real, subject);
          assert(item.subject === subject, "wrong message matched");
        });
      });
  }

  // ── capture_takes_precedence_over_redirect ───────────────────────────────────
  {
    const t =
      "capture_takes_precedence_over_redirect: TINA4_MAIL_CAPTURE wins over " +
      "TINA4_MAIL_REDIRECT_TO — nothing reaches GreenMail, the DevMailbox gets exactly 1 message";
    if (!greenmailUp) skip(t, gmDown);
    else
      await check(t, async () => {
        const dev1 = uniqueAddr("capdev1", "x.test");
        const dev2 = uniqueAddr("capdev2", "x.test");
        const real = uniqueAddr("capreal", "y.test");
        const subject = `mailredirect-capture-${randomBytes(4).toString("hex")}`;
        const mailboxDir = mkdtempSync(join(tmpdir(), "tina4-mailredirect-"));

        try {
          await withEnv(
            {
              TINA4_MAIL_CAPTURE: "true",
              TINA4_MAIL_REDIRECT_TO: `${dev1},${dev2}`,
              TINA4_MAILBOX_DIR: mailboxDir,
            },
            async () => {
              // A REAL SMTP host is configured too, so capture wins on the MERITS
              // of TINA4_MAIL_CAPTURE, not merely because sending was unavailable.
              const messenger = new Messenger({
                host: SMTP_HOST,
                port: SMTP_PORT,
                encryption: "none",
                fromAddress: "sender@tina4.test",
              });
              const result = await messenger.send(real, subject, "must never leave this box");
              assert(result.success, `capture send reported failure: ${result.message}`);

              // Nothing reached GreenMail at all — dev list AND the real recipient
              // stay empty (a shorter budget suffices: capture short-circuits
              // before any socket is opened, so a mutation would surface fast).
              const [dev1Absent, dev2Absent, realAbsent] = await Promise.all([
                staysAbsent(dev1, subject, 16, 250),
                staysAbsent(dev2, subject, 16, 250),
                staysAbsent(real, subject, 16, 250),
              ]);
              assert(dev1Absent, `dev1 (${dev1}) received mail despite TINA4_MAIL_CAPTURE`);
              assert(dev2Absent, `dev2 (${dev2}) received mail despite TINA4_MAIL_CAPTURE`);
              assert(realAbsent, `the real recipient (${real}) received mail despite TINA4_MAIL_CAPTURE`);

              // Exactly one message landed in the local DevMailbox.
              const count = outboxCount(mailboxDir);
              assert(count === 1, `expected exactly 1 captured message, found ${count}`);
            },
          );
        } finally {
          rmSync(mailboxDir, { recursive: true, force: true });
        }
      });
  }

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
