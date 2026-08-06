/**
 * Messenger parity fixes for 3.13.96 — the parts provable WITHOUT a mail server.
 * Run with: npx tsx test/messengerParity31396.test.ts
 *
 * G6  send() carries {success, message, id} on BOTH paths — id:null on failure
 *     (it used to OMIT id, so a caller reading `result.id` got undefined on the
 *     failure branch and a string on success: two shapes from one method).
 * G7  markUnread / sendTemplate exist in Node's idiomatic casing; deleteMessage
 *     is renamed to delete, with deleteMessage kept as a deprecated alias.
 * G10 read methods RAISE MessengerConnectionError on a real connection failure
 *     (a genuinely closed port — no mock), while send() RETURNS a result; and
 *     TINA4_MAIL_CAPTURE forces capture.
 *
 * NO MOCKS. The closed-port cases connect to a REAL socket that is genuinely
 * refused; the capture cases write REAL JSON to a temp dir and read it back.
 * The GreenMail round-trip (G3 snippet, G4 date, G5 attachments, G8 IMAP creds)
 * lives in messengerGreenMail.test.ts, which needs the live server.
 */
import net from "node:net";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Messenger, MessengerConnectionError } from "../packages/core/src/messenger.js";

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
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

/** A port that is definitely closed: bind to :0, capture the port, close it. */
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

async function main(): Promise<void> {
  console.log("\nmessenger parity 3.13.96 (G6, G7, G10 — no server needed)\n");

  // ── G6. send() failure carries id: null (both paths share {success,message,id}) ──
  console.log("-- G6: send() failure path includes id: null --");

  await check("+ a failed send (no recipients) returns id: null, not an omitted key", async () => {
    // A host IS configured so send() takes the SMTP branch, not dev-capture.
    const m = new Messenger({ host: "127.0.0.1", port: 25, encryption: "none", fromAddress: "s@t.test" });
    const r = await m.send([], "Subj", "body");
    assert(r.success === false, `expected failure, got ${JSON.stringify(r)}`);
    assert("id" in r, "the failure result OMITTED id — both paths must carry {success, message, id}");
    assert(r.id === null, `id must be null on failure, got ${JSON.stringify(r.id)}`);
    assert(typeof r.message === "string" && r.message.length > 0, "message must be present");
  });

  await check("+ a failed send (connection refused) returns id: null", async () => {
    const port = await closedPort();
    const m = new Messenger({ host: "127.0.0.1", port, encryption: "none", fromAddress: "s@t.test" });
    const r = await m.send("to@t.test", "Subj", "body");
    assert(r.success === false, `expected failure, got ${JSON.stringify(r)}`);
    assert("id" in r && r.id === null, `id must be null on the SMTP-error path, got ${JSON.stringify(r)}`);
  });

  await check("- a SUCCESSFUL (captured) send still carries a real id, never null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tina4-mbox-"));
    const saved = process.env.TINA4_MAILBOX_DIR;
    process.env.TINA4_MAILBOX_DIR = dir;
    try {
      // No host -> dev capture -> success with a real id. This is the other
      // half of the contract: id:null is the FAILURE value, never the success one.
      const m = new Messenger({ fromAddress: "s@t.test" });
      const r = await m.send("to@t.test", "Subj", "body");
      assert(r.success === true, `expected capture success, got ${JSON.stringify(r)}`);
      assert(typeof r.id === "string" && r.id.length > 0, `success id must be a real id, got ${JSON.stringify(r.id)}`);
    } finally {
      if (saved === undefined) delete process.env.TINA4_MAILBOX_DIR; else process.env.TINA4_MAILBOX_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G7. markUnread / sendTemplate exist; delete renames deleteMessage ─────────
  console.log("\n-- G7: markUnread, sendTemplate, delete (+ deprecated deleteMessage alias) --");

  await check("+ every method exists under its idiomatic name", () => {
    const m = new Messenger({ host: "127.0.0.1", encryption: "none" });
    for (const name of ["markUnread", "sendTemplate", "delete", "deleteMessage", "markRead"]) {
      assert(typeof (m as any)[name] === "function", `Messenger has no ${name}()`);
    }
  });

  await check("- deleteMessage delegates to delete (same IMAP path, not a no-op stub)", async () => {
    // No-mock delegation proof: on a genuinely closed IMAP port BOTH delete() and
    // its alias reach imapConnect() and throw. A stubbed/divergent alias that
    // quietly returned would NOT throw — so this discriminates a real delegation
    // from a hollow one without a spy.
    const port = await closedPort();
    const m = new Messenger({ imapHost: "127.0.0.1", imapPort: port, imapEncryption: "none", imapUser: "u", imapPass: "p" });
    let deleteThrew = false;
    let aliasThrew = false;
    try { await m.delete("1"); } catch { deleteThrew = true; }
    try { await m.deleteMessage("1"); } catch { aliasThrew = true; }
    assert(deleteThrew, "delete() must hit the real IMAP path (throw on a closed port)");
    assert(aliasThrew, "deleteMessage() must delegate to the same path (throw on a closed port), not no-op");
  });

  await check("+ sendTemplate renders the template and sends it (captured, html)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tina4-mbox-"));
    const saved = process.env.TINA4_MAILBOX_DIR;
    process.env.TINA4_MAILBOX_DIR = dir;
    try {
      const m = new Messenger({ fromAddress: "s@t.test" }); // no host -> capture
      const r = await m.sendTemplate("to@t.test", "Hi", "<p>Hello {{ name }}</p>", { name: "Ada" });
      assert(r.success === true, `sendTemplate should succeed via capture, got ${JSON.stringify(r)}`);
      const files = readdirSync(join(dir, "outbox")).filter((f) => f.endsWith(".json"));
      assert(files.length === 1, `expected 1 captured message, found ${files.length}`);
      const msg = JSON.parse(readFileSync(join(dir, "outbox", files[0]), "utf-8"));
      assert(String(msg.body).includes("Ada"), `template variable not rendered: ${JSON.stringify(msg.body)}`);
      assert(!String(msg.body).includes("{{"), `template left unrendered: ${JSON.stringify(msg.body)}`);
      assert(msg.html === true, "sendTemplate must send as HTML");
    } finally {
      if (saved === undefined) delete process.env.TINA4_MAILBOX_DIR; else process.env.TINA4_MAILBOX_DIR = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G10. read methods raise on a closed port; send() returns; capture gate ────
  console.log("\n-- G10: read-raises-on-connection-failure, capture gate --");

  {
    const port = await closedPort();
    const m = new Messenger({ imapHost: "127.0.0.1", imapPort: port, imapEncryption: "none", imapUser: "u", imapPass: "p" });
    const readMethods: Array<[string, () => Promise<unknown>]> = [
      ["inbox", () => m.inbox()],
      ["read", () => m.read("1")],
      ["unread", () => m.unread()],
      ["search", () => m.search()],
      ["folders", () => m.folders()],
    ];
    for (const [name, call] of readMethods) {
      await check(`+ ${name}() RAISES MessengerConnectionError on a genuinely closed port`, async () => {
        let raised: unknown = null;
        try { await call(); } catch (e) { raised = e; }
        assert(raised instanceof MessengerConnectionError,
          `expected MessengerConnectionError, got ${raised === null ? "no throw" : String(raised)}`);
      });
    }
    await check("- send() on a dead port RETURNS a result, it does NOT raise", async () => {
      const sm = new Messenger({ host: "127.0.0.1", port, encryption: "none", fromAddress: "s@t.test" });
      let raised: unknown = null;
      let result: unknown = null;
      try { result = await sm.send("to@t.test", "S", "b"); } catch (e) { raised = e; }
      assert(raised === null, `send() must not throw on a connection failure, it threw ${String(raised)}`);
      assert(result !== null && (result as any).success === false, `send() must return a failure result, got ${JSON.stringify(result)}`);
    });
  }

  await check("+ TINA4_MAIL_CAPTURE forces capture even when an SMTP host IS configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tina4-mbox-"));
    const saved = { d: process.env.TINA4_MAILBOX_DIR, c: process.env.TINA4_MAIL_CAPTURE };
    process.env.TINA4_MAILBOX_DIR = dir;
    process.env.TINA4_MAIL_CAPTURE = "true";
    try {
      // A real host is set, but capture is forced, so nothing hits the network.
      const m = new Messenger({ host: "127.0.0.1", port: 25, encryption: "none", fromAddress: "s@t.test" });
      const r = await m.send("to@t.test", "S", "b");
      assert(r.success === true, `forced capture should succeed offline, got ${JSON.stringify(r)}`);
      const files = readdirSync(join(dir, "outbox")).filter((f) => f.endsWith(".json"));
      assert(files.length === 1, `capture should have written one message, found ${files.length}`);
    } finally {
      if (saved.d === undefined) delete process.env.TINA4_MAILBOX_DIR; else process.env.TINA4_MAILBOX_DIR = saved.d;
      if (saved.c === undefined) delete process.env.TINA4_MAIL_CAPTURE; else process.env.TINA4_MAIL_CAPTURE = saved.c;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n${"=".repeat(52)}`);
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log(`${"=".repeat(52)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

await main();
