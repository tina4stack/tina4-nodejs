/**
 * REGRESSION: nodejs#41 and nodejs#42. Run with: npx tsx test/messengerContract.test.ts
 *
 * Four contract points, each with a POSITIVE test (the right behaviour is
 * accepted) and a NEGATIVE test (the wrong behaviour is rejected). The same
 * eight run in all four frameworks. Contract and the ADR-0004 ranking:
 * tina4-documentation/plan/v3/messenger-contract.md.
 *
 * Every one of these fails against 3.13.92, which is the point: they were
 * written before the fix so the red proves the bug was reproduced rather than
 * imagined.
 *
 *   #41  createMessenger() is typed Messenger | DevMailbox and the two share no
 *        sending method. DevMailbox has capture(), Messenger has send(). The
 *        documented call (docs/nodejs/16-email.md:504 tells you to prefer the
 *        factory) throws TypeError the moment the dev branch is taken -- which is
 *        every local dev box, every CI run, and any pod that does not set
 *        NODE_ENV=production.
 *
 *   #42  send()'s 5th positional argument is `text`; capture()'s is `cc`. Moving a
 *        working send(...) call across therefore files the plain-text body as a CC
 *        RECIPIENT, stores it, and reports success.
 *
 *   plus two gaps found while ranking the four frameworks: cc/bcc are not
 *        normalised (a bare string is stored where string[] is declared), and
 *        EmailMessage has no `text` field at all, so a captured message is not
 *        what would have been sent.
 *
 * The dev-capture gate is TINA4_DEBUG truthy OR no SMTP host configured (contract
 * point 3), so withMailbox() sets TINA4_DEBUG and clears TINA4_MAIL_HOST -- both
 * conditions, the state of any dev box. Node's third clause today (capture when
 * NODE_ENV != production even with SMTP configured) is the one the contract drops.
 *
 * NO MOCKS. DevMailbox writes real JSON to disk, so each test points
 * TINA4_MAILBOX_DIR at a fresh temp directory and reads the file back.
 */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMessenger, Messenger } from "../packages/core/src/index.js";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => unknown): Promise<void> {
  try {
    // MUST await. The first version of this file took a sync callback, so an
    // async test body returned a pending promise, check() saw no throw, and two
    // genuinely failing assertions were counted as passes -- a test that passes
    // without asserting, which is worse than no test.
    await fn();
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } catch (err) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       ${(err as Error).message}`);
    fail++;
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Fresh mailbox dir per test, dev path active per the contract's gate. */
async function withMailbox<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "tina4-mailbox-"));
  const saved = {
    dir: process.env.TINA4_MAILBOX_DIR,
    host: process.env.TINA4_MAIL_HOST,
    debug: process.env.TINA4_DEBUG,
    env: process.env.NODE_ENV,
  };
  process.env.TINA4_MAILBOX_DIR = dir;
  process.env.TINA4_DEBUG = "true";
  delete process.env.TINA4_MAIL_HOST; // no SMTP -> the dev path, as on any dev box
  delete process.env.NODE_ENV;
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of [
      ["TINA4_MAILBOX_DIR", saved.dir],
      ["TINA4_MAIL_HOST", saved.host],
      ["TINA4_DEBUG", saved.debug],
      ["NODE_ENV", saved.env],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The single captured message, read back off disk. */
function readCaptured(dir: string): Record<string, unknown> {
  const outbox = join(dir, "outbox");
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json"));
  assert(files.length === 1, `expected exactly 1 captured message, found ${files.length}`);
  return JSON.parse(readFileSync(join(outbox, files[0]), "utf-8"));
}

/** Whatever the factory hands back, called as the docs say to call it. */
type Sender = { send: (...a: unknown[]) => unknown };

console.log("\nmessenger contract (nodejs#41, #42)\n");

// --- 1. the factory returns ONE type, and it can send ----------------------

await check("+ createMessenger() returns something with a callable send()", async () => {
  await withMailbox(() => {
    const mail = createMessenger();
    assert(
      typeof (mail as Partial<Sender>).send === "function",
      `createMessenger() returned ${mail.constructor.name} whose send is ` +
        `${typeof (mail as Partial<Sender>).send}. The factory is the documented ` +
        `way to get a mailer, so every branch it can return must expose send().`,
    );
  });
});

await check("- createMessenger() never returns a capture-only object", async () => {
  await withMailbox(() => {
    const mail = createMessenger() as Partial<Sender> & { capture?: unknown };
    const hasSend = typeof mail.send === "function";
    const captureOnly = typeof mail.capture === "function" && !hasSend;
    assert(
      !captureOnly,
      `createMessenger() returned ${(mail as object).constructor.name}, which offers ` +
        `capture() but not send(). Callers holding the factory result cannot send ` +
        `without branching on the concrete type -- that is nodejs#41.`,
    );
  });
});

// --- 2. text is the 5th positional and lands in text -----------------------

await check("+ a captured message round-trips text", async () => {
  await withMailbox(async (dir) => {
    const mail = createMessenger() as Sender;
    assert(typeof mail.send === "function", "no send() to call (see #41)");
    await mail.send("a@b.com", "Subj", "<p>body</p>", true, "the text part");
    const msg = readCaptured(dir);
    assert(
      "text" in msg,
      "EmailMessage has no text field at all, so the captured message is not what " +
        "would have been sent",
    );
    assert(msg.text === "the text part", `text round-trip failed: ${JSON.stringify(msg.text)}`);
  });
});

await check("- the plain-text body is never stored as a cc recipient", async () => {
  await withMailbox(async (dir) => {
    const mail = createMessenger() as Sender;
    assert(typeof mail.send === "function", "no send() to call (see #41)");
    await mail.send("a@b.com", "Subject", "<p>hi</p>", true, "plain text alternative");
    const msg = readCaptured(dir);
    const cc = Array.isArray(msg.cc) ? msg.cc : msg.cc === undefined ? [] : [msg.cc];
    assert(
      !cc.includes("plain text alternative"),
      `the plain-text body was filed as a CC recipient: cc=${JSON.stringify(msg.cc)} -- ` +
        `that is nodejs#42`,
    );
  });
});

// --- 3. cc/bcc are normalised at the boundary ------------------------------

await check("+ a proper cc list passes through unchanged", async () => {
  await withMailbox(async (dir) => {
    const mail = createMessenger() as Sender;
    assert(typeof mail.send === "function", "no send() to call (see #41)");
    await mail.send("a@b.com", "S", "<p>b</p>", true, undefined, ["x@y.com", "p@q.com"]);
    const msg = readCaptured(dir);
    assert(
      JSON.stringify(msg.cc) === JSON.stringify(["x@y.com", "p@q.com"]),
      `a valid cc list was altered: ${JSON.stringify(msg.cc)}`,
    );
  });
});

await check("- a bare-string cc is not stored as a bare string", async () => {
  await withMailbox(async (dir) => {
    // Deliberately passing a string where string[] is declared: plain JS callers
    // and anyone holding the union get no compile-time warning, so the runtime
    // must cope rather than store a malformed message and report success. A dev
    // mailbox that accepts a broken message defeats its own purpose -- it exists
    // to show you what you would have sent.
    const mail = createMessenger() as Sender;
    assert(typeof mail.send === "function", "no send() to call (see #41)");
    await mail.send("a@b.com", "Subject", "<p>hi</p>", true, undefined, "one@cc.com");
    const msg = readCaptured(dir);
    assert(
      typeof msg.cc !== "string",
      `cc was stored as a bare string where string[] is declared: ${JSON.stringify(msg.cc)}`,
    );
    assert(
      JSON.stringify(msg.cc) === JSON.stringify(["one@cc.com"]),
      `cc was not normalised: ${JSON.stringify(msg.cc)} (expected ["one@cc.com"])`,
    );
  });
});

// --- 4. interception is a branch, not a separate type ----------------------

await check("+ the object's send is the class's send", async () => {
  await withMailbox(() => {
    const mail = createMessenger() as Partial<Sender>;
    assert(
      mail.send === (Messenger.prototype as unknown as Sender).send,
      `the returned object's send is not Messenger.prototype.send. Interception ` +
        `must be a real branch INSIDE send(), so one name means one signature ` +
        `(got ${(mail as object).constructor.name}).`,
    );
  });
});

await check("- send is not an own property, and the type is Messenger", async () => {
  await withMailbox(() => {
    const mail = createMessenger();
    assert(
      !Object.prototype.hasOwnProperty.call(mail, "send"),
      "send is an own property of the instance, so it has been assigned over. " +
        "Interception must be a real branch inside Messenger.send().",
    );
    assert(
      mail instanceof Messenger,
      `createMessenger() returned ${mail.constructor.name}, not a Messenger. The ` +
        `factory must return ONE concrete type -- never a union.`,
    );
  });
});

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
