/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * ADR-0071: mail encryption means what it says.
 *
 *   - one SMTP transport table: port 465 is always implicit TLS, `ssl` is
 *     implicit TLS on ANY port, `tls` / `starttls` require STARTTLS (the send
 *     fails before AUTH / MAIL FROM when the server does not offer it), `none`
 *     never upgrades;
 *   - an unknown value raises at construction (a typo never means cleartext);
 *   - every TLS connection (SMTP implicit, SMTP STARTTLS, IMAPS, IMAP STARTTLS)
 *     verifies the certificate and host name, with no Tina4 switch to turn it
 *     off. TINA4_MAIL_TLS_INSECURE is withdrawn; a private CA is trusted with
 *     NODE_EXTRA_CA_CERTS, as for any other TLS client in the process.
 *
 * NO mocks. The pure-logic part needs no server. The live part drives the real
 * TLS mail servers stood up by test/mail-infra.sh (CI) or the lab:
 *
 *   4025 GreenMail SMTP + AUTH, no STARTTLS    4465 GreenMail SMTPS (implicit TLS)
 *   4143 GreenMail IMAP + LOGIN                4993 GreenMail IMAPS
 *   4587 Mailpit SMTP, STARTTLS required       4825 Mailpit HTTP API
 *   4144 Dovecot IMAP with STARTTLS (any user, password "pass")
 *
 * The Messenger runs in a child Node process (test/fixtures/mailTransportChild.ts)
 * so the parent decides what it trusts. The trusted child gets
 * NODE_EXTRA_CA_CERTS=<test CA>. The untrusted child gets no CA, and ALSO
 * TINA4_MAIL_TLS_INSECURE=true and NODE_TLS_REJECT_UNAUTHORIZED=0: every
 * refusal there proves no switch turns verification off. Delivery is checked
 * out of band: GreenMail over its plain IMAP port, Mailpit over its HTTP API.
 *
 * Run with: npx tsx test/mailTransportTls.test.ts
 */
import net from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Messenger } from "../packages/core/src/messenger.ts";

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

function raisedMessage(construct: () => unknown): string | null {
  try {
    construct();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The private transport decision, read without a server. */
function transportOf(messenger: Messenger): string {
  try {
    return (messenger as unknown as { smtpTransport(): string }).smtpTransport();
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function withoutMailEnv<T>(run: () => T): T {
  const saved = { encryption: process.env.TINA4_MAIL_ENCRYPTION, imap: process.env.TINA4_MAIL_IMAP_ENCRYPTION };
  delete process.env.TINA4_MAIL_ENCRYPTION;
  delete process.env.TINA4_MAIL_IMAP_ENCRYPTION;
  try {
    return run();
  } finally {
    if (saved.encryption !== undefined) process.env.TINA4_MAIL_ENCRYPTION = saved.encryption;
    if (saved.imap !== undefined) process.env.TINA4_MAIL_IMAP_ENCRYPTION = saved.imap;
  }
}

console.log("=== ADR-0071 mail encryption ===\n");

// ── Pure logic: the transport table and the refusals ─────────────────────
console.log("--- SMTP transport table ---");
withoutMailEnv(() => {
  const table: Array<[string, number, string]> = [
    ["ssl", 465, "implicit_tls"],
    ["ssl", 2465, "implicit_tls"],
    ["ssl", 587, "implicit_tls"],
    ["tls", 465, "implicit_tls"],
    ["tls", 587, "starttls"],
    ["starttls", 465, "implicit_tls"],
    ["starttls", 25, "starttls"],
    ["none", 465, "implicit_tls"],
    ["none", 25, "plain"],
  ];
  for (const [encryption, port, expected] of table) {
    const actual = transportOf(new Messenger({ host: "mail.example", port, encryption }));
    assert(`encryption ${encryption} on port ${port} -> ${expected}`, actual === expected, `got ${actual}`);
  }

  for (const [given, normalised] of [["SSL", "ssl"], [" tls ", "tls"], ["StartTLS", "starttls"], ["NONE", "none"]]) {
    const messenger = new Messenger({ host: "mail.example", encryption: given });
    const stored = (messenger as unknown as { encryption: string }).encryption;
    assert(`encryption ${JSON.stringify(given)} is trimmed and case-folded to ${normalised}`, stored === normalised, `got ${stored}`);
  }

  const defaulted = transportOf(new Messenger({ host: "mail.example", port: 587 }));
  assert("the default is still tls: STARTTLS on 587", defaulted === "starttls", `got ${defaulted}`);
});

console.log("\n--- Unknown values are refused at construction ---");
withoutMailEnv(() => {
  for (const bad of ["tsl", "ssl3", "yes", "", "   "]) {
    const message = raisedMessage(() => new Messenger({ host: "mail.example", encryption: bad }));
    assert(`encryption ${JSON.stringify(bad)} raises the ADR message`,
      message === `Unknown mail encryption '${bad}'. Valid values: ssl, tls, starttls, none.`, `got ${message}`);
  }

  // From the environment: an unknown or explicitly EMPTY value raises (shown as
  // given); only an unset variable falls back to the default "tls".
  for (const bad of ["tsl", "", " "]) {
    process.env.TINA4_MAIL_ENCRYPTION = bad;
    try {
      const message = raisedMessage(() => new Messenger({ host: "mail.example" }));
      assert(`TINA4_MAIL_ENCRYPTION=${JSON.stringify(bad)} raises too`,
        message === `Unknown mail encryption '${bad}'. Valid values: ssl, tls, starttls, none.`, `got ${message}`);
    } finally {
      delete process.env.TINA4_MAIL_ENCRYPTION;
    }
  }
  process.env.TINA4_MAIL_IMAP_ENCRYPTION = "";
  try {
    const message = raisedMessage(() => new Messenger({ imapHost: "mail.example" }));
    assert("TINA4_MAIL_IMAP_ENCRYPTION=\"\" raises",
      message === "Unknown IMAP encryption ''. Valid values: ssl, tls, starttls, none.", `got ${message}`);
  } finally {
    delete process.env.TINA4_MAIL_IMAP_ENCRYPTION;
  }
  const unsetImap = new Messenger({ imapHost: "mail.example" }).getImapEncryption();
  assert("an unset TINA4_MAIL_IMAP_ENCRYPTION defaults to tls", unsetImap === "tls", `got ${unsetImap}`);

  for (const bad of ["tsl", "imaps", ""]) {
    const message = raisedMessage(() => new Messenger({ imapHost: "mail.example", imapEncryption: bad }));
    assert(`IMAP encryption ${JSON.stringify(bad)} raises`,
      message === `Unknown IMAP encryption '${bad}'. Valid values: ssl, tls, starttls, none.`, `got ${message}`);
  }
  const imapSsl = new Messenger({ imapHost: "mail.example", imapEncryption: " SSL " }).getImapEncryption();
  assert("IMAP encryption ' SSL ' is accepted as ssl (implicit TLS)", imapSsl === "ssl", `got ${imapSsl}`);
});

// ── Live: the real TLS mail servers ──────────────────────────────────────
const HOST = process.env.TINA4_TEST_MAIL_TLS_HOST || "127.0.0.1";
const CA_FILE = process.env.TINA4_TEST_MAIL_TLS_CA_FILE || "";
const USERNAME = "tina4";
const PASSWORD = "mail-secret";
const MAILBOX = "tina4@tina4.test";
const SMTP_PLAIN_AUTH = 4025;
const SMTPS = 4465;
const IMAP_PLAIN = 4143;
const IMAPS = 4993;
const SMTP_STARTTLS = 4587;
const MAILPIT_API = 4825;
const IMAP_STARTTLS = 4144;
const ALL_PORTS = [SMTP_PLAIN_AUTH, SMTPS, IMAP_PLAIN, IMAPS, SMTP_STARTTLS, MAILPIT_API, IMAP_STARTTLS];

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port, timeout: 1000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

const unique = (label: string) => `adr0071-${label}-${randomBytes(4).toString("hex")}`;

function smtp(port: number, encryption: string): Record<string, unknown> {
  return { host: HOST, port, encryption, username: USERNAME, password: PASSWORD, fromAddress: "sender@tina4.test" };
}

/** Run actions in a fresh Node; `trusted` decides whether the test CA is in its store. */
function child(actions: unknown[], trusted: boolean): Record<string, Record<string, unknown>> {
  const env: NodeJS.ProcessEnv = { ...process.env, MAIL_TEST_INPUT: JSON.stringify(actions), TINA4_NO_BROWSER: "true" };
  for (const name of ["TINA4_MAIL_CAPTURE", "TINA4_MAIL_REDIRECT_TO", "TINA4_MAIL_ENCRYPTION", "TINA4_MAIL_IMAP_ENCRYPTION",
    "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "TINA4_MAIL_TLS_INSECURE"]) delete env[name];
  if (trusted) {
    env.NODE_EXTRA_CA_CERTS = CA_FILE;
  } else {
    // Every switch that ever turned verification off, on at once.
    env.TINA4_MAIL_TLS_INSECURE = "true";
    env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const run = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "mailTransportChild.ts")],
    { env, encoding: "utf-8", timeout: 110_000 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const marker = output.lastIndexOf("@@RESULT@@");
  if (marker === -1) throw new Error(`mail child failed (status ${run.status}):\n${output}`);
  return JSON.parse(output.slice(marker + "@@RESULT@@".length).split("\n")[0]);
}

async function greenMailSubjects(): Promise<string[]> {
  // Out of band: GreenMail's plain IMAP port, not a TLS path under test.
  const reader = new Messenger({ imapHost: HOST, imapPort: IMAP_PLAIN, imapEncryption: "none",
    imapUser: USERNAME, imapPass: PASSWORD });
  return (await reader.inbox("INBOX", 200)).map((message) => message.subject);
}

async function mailpitHas(subject: string): Promise<boolean> {
  const url = `http://${HOST}:${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`;
  const found = (await (await fetch(url)).json()) as { messages: Array<{ Subject: string }> };
  return found.messages.some((message) => message.Subject === subject);
}

const certificateError = (text: unknown) => /certificate/i.test(String(text ?? ""));

console.log("\n--- Live TLS mail servers ---");
if (!CA_FILE || !existsSync(CA_FILE)) {
  console.log("  \x1b[33mSKIP\x1b[0m TLS mail servers (SMTP/IMAP) not set: run test/mail-infra.sh and export "
    + "TINA4_TEST_MAIL_TLS_HOST / TINA4_TEST_MAIL_TLS_CA_FILE");
} else if (!(await Promise.all(ALL_PORTS.map(reachable))).every(Boolean)) {
  console.log(`  \x1b[33mSKIP\x1b[0m TLS mail servers (SMTP/IMAP) not reachable at ${HOST} ports ${ALL_PORTS.join(", ")}`);
} else {
  const subject = {
    sslTls: unique("ssl-4465"), sslPlain: unique("ssl-plain"), tls: unique("tls-starttls"), starttls: unique("starttls"),
    tlsNotOffered: unique("tls-not-offered"), starttlsNotOffered: unique("starttls-not-offered"),
    noneStarttlsOnly: unique("none-on-starttls"), nonePlain: unique("none-plain"),
    untrustedSsl: unique("untrusted-ssl"), untrustedStarttls: unique("untrusted-starttls"),
  };
  const dovecotUser = `node${randomBytes(4).toString("hex")}`;
  const imaps = (encryption: string) => ({ imapHost: HOST, imapPort: IMAPS, imapEncryption: encryption,
    imapUser: USERNAME, imapPass: PASSWORD });
  const imapStarttls = { imapHost: HOST, imapPort: IMAP_STARTTLS, imapEncryption: "starttls",
    imapUser: dovecotUser, imapPass: "pass" };

  const trusted = child([
    { id: "sslTls", action: "send", messenger: smtp(SMTPS, "ssl"), to: MAILBOX, subject: subject.sslTls },
    { id: "sslPlain", action: "send", messenger: smtp(SMTP_PLAIN_AUTH, "ssl"), to: MAILBOX, subject: subject.sslPlain },
    { id: "connectSsl", action: "testConnection", messenger: smtp(SMTPS, "ssl") },
    { id: "connectSslPlain", action: "testConnection", messenger: smtp(SMTP_PLAIN_AUTH, "ssl") },
    { id: "connectStarttls", action: "testConnection", messenger: smtp(SMTP_STARTTLS, "tls") },
    { id: "connectNotOffered", action: "testConnection", messenger: smtp(SMTP_PLAIN_AUTH, "tls") },
    { id: "tls", action: "send", messenger: smtp(SMTP_STARTTLS, "tls"), to: "rcpt@tina4.test", subject: subject.tls },
    { id: "starttls", action: "send", messenger: smtp(SMTP_STARTTLS, "starttls"), to: "rcpt@tina4.test", subject: subject.starttls },
    { id: "tlsNotOffered", action: "send", messenger: smtp(SMTP_PLAIN_AUTH, "tls"), to: MAILBOX, subject: subject.tlsNotOffered },
    { id: "starttlsNotOffered", action: "send", messenger: smtp(SMTP_PLAIN_AUTH, "starttls"), to: MAILBOX, subject: subject.starttlsNotOffered },
    { id: "noneStarttlsOnly", action: "send", messenger: smtp(SMTP_STARTTLS, "none"), to: "rcpt@tina4.test", subject: subject.noneStarttlsOnly },
    { id: "nonePlain", action: "send", messenger: smtp(SMTP_PLAIN_AUTH, "none"), to: MAILBOX, subject: subject.nonePlain },
    { id: "imapsTls", action: "findSubject", messenger: imaps("tls"), subject: subject.sslTls },
    { id: "imapsSsl", action: "findSubject", messenger: imaps("ssl"), subject: subject.sslTls },
    { id: "imapStarttls", action: "inbox", messenger: imapStarttls },
    // A plaintext client on an implicit-TLS port waits for a greeting that never
    // comes: the connection check must give up (10 s, as Python's smtplib), not hang.
    { id: "connectPlainOnTls", action: "testConnection", messenger: smtp(SMTPS, "none") },
  ], true);

  const untrusted = child([
    { id: "sslTls", action: "send", messenger: smtp(SMTPS, "ssl"), to: MAILBOX, subject: subject.untrustedSsl },
    { id: "starttls", action: "send", messenger: smtp(SMTP_STARTTLS, "starttls"), to: "rcpt@tina4.test", subject: subject.untrustedStarttls },
    { id: "connectSsl", action: "testConnection", messenger: smtp(SMTPS, "ssl") },
    { id: "imaps", action: "inbox", messenger: imaps("tls") },
    { id: "imapStarttls", action: "inbox", messenger: imapStarttls },
  ], false);

  const show = (value: unknown) => JSON.stringify(value);
  const notOffered = `STARTTLS was requested but ${HOST}:${SMTP_PLAIN_AUTH} does not offer it`;

  console.log("\n  SMTP implicit TLS (ssl on a non-465 port)");
  assert("ssl on 4465 delivers over implicit TLS", trusted.sslTls.success === true, show(trusted.sslTls));
  assert("ssl on a plaintext-only port FAILS instead of sending in clear", trusted.sslPlain.success === false, show(trusted.sslPlain));
  assert("testConnection uses the same rules: ssl on 4465 connects", trusted.connectSsl.success === true, show(trusted.connectSsl));
  assert("testConnection: ssl on a plaintext-only port fails", trusted.connectSslPlain.success === false, show(trusted.connectSslPlain));

  console.log("\n  SMTP STARTTLS (required)");
  assert("tls delivers through STARTTLS", trusted.tls.success === true, show(trusted.tls));
  assert("starttls delivers through STARTTLS", trusted.starttls.success === true, show(trusted.starttls));
  assert("testConnection: tls upgrades with STARTTLS", trusted.connectStarttls.success === true, show(trusted.connectStarttls));
  assert("tls against a server without STARTTLS fails before AUTH / MAIL FROM",
    trusted.tlsNotOffered.success === false && trusted.tlsNotOffered.message === notOffered, show(trusted.tlsNotOffered));
  assert("starttls against a server without STARTTLS fails the same way",
    trusted.starttlsNotOffered.success === false && trusted.starttlsNotOffered.message === notOffered, show(trusted.starttlsNotOffered));
  assert("testConnection: tls against a server without STARTTLS fails",
    trusted.connectNotOffered.success === false && trusted.connectNotOffered.message === notOffered, show(trusted.connectNotOffered));
  assert("none never upgrades, so a STARTTLS-only server refuses the mail", trusted.noneStarttlsOnly.success === false, show(trusted.noneStarttlsOnly));
  assert("POSITIVE: none on a plaintext server still delivers", trusted.nonePlain.success === true, show(trusted.nonePlain));

  assert("testConnection gives up on a server that never greets (idle timeout, no hang)",
    trusted.connectPlainOnTls.success === false && /timed out after 10s/.test(String(trusted.connectPlainOnTls.message)),
    show(trusted.connectPlainOnTls));

  console.log("\n  IMAP");
  assert("IMAPS (imapEncryption tls) reads the mail sent over ssl", show(trusted.imapsTls) === show({ found: true }), show(trusted.imapsTls));
  assert("IMAPS (imapEncryption ssl) reads it too", show(trusted.imapsSsl) === show({ found: true }), show(trusted.imapsSsl));
  assert("IMAP starttls upgrades, logs in and reads (Dovecot)", show(trusted.imapStarttls) === show({ count: 0 }), show(trusted.imapStarttls));

  console.log("\n  Certificates are always verified (untrusted CA, TINA4_MAIL_TLS_INSECURE=true, NODE_TLS_REJECT_UNAUTHORIZED=0)");
  assert("SMTP implicit TLS to an untrusted certificate fails",
    untrusted.sslTls.success === false && certificateError(untrusted.sslTls.message), show(untrusted.sslTls));
  assert("SMTP STARTTLS to an untrusted certificate fails",
    untrusted.starttls.success === false && certificateError(untrusted.starttls.message), show(untrusted.starttls));
  assert("testConnection to an untrusted certificate fails",
    untrusted.connectSsl.success === false && certificateError(untrusted.connectSsl.message), show(untrusted.connectSsl));
  assert("IMAPS to an untrusted certificate raises MessengerConnectionError",
    untrusted.imaps.errorClass === "MessengerConnectionError" && certificateError(untrusted.imaps.error), show(untrusted.imaps));
  assert("IMAP STARTTLS to an untrusted certificate raises MessengerConnectionError",
    untrusted.imapStarttls.errorClass === "MessengerConnectionError" && certificateError(untrusted.imapStarttls.error), show(untrusted.imapStarttls));

  console.log("\n  Out of band: what the servers actually received");
  let greenMail: string[] = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    greenMail = await greenMailSubjects();
    if (greenMail.includes(subject.sslTls) && greenMail.includes(subject.nonePlain)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert("GreenMail holds the ssl mail", greenMail.includes(subject.sslTls));
  assert("GreenMail holds the none (plaintext on purpose) mail", greenMail.includes(subject.nonePlain));
  for (const refused of ["sslPlain", "tlsNotOffered", "starttlsNotOffered", "untrustedSsl"] as const) {
    assert(`GreenMail never received the ${refused} mail`, !greenMail.includes(subject[refused]));
  }
  assert("Mailpit holds the tls mail", await mailpitHas(subject.tls));
  assert("Mailpit holds the starttls mail", await mailpitHas(subject.starttls));
  assert("Mailpit never received the none mail", !(await mailpitHas(subject.noneStarttlsOnly)));
  assert("Mailpit never received the untrusted-certificate mail", !(await mailpitHas(subject.untrustedStarttls)));
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
