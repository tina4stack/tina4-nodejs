# Set Up Tina4 Email (Send & Receive)

Send and read emails using the built-in Messenger module (SMTP + IMAP, Node built-ins only).

## Instructions

1. Configure SMTP/IMAP in `.env`
2. Use `Messenger` to send emails
3. Use `Messenger` to read emails via IMAP

## .env

```bash
TINA4_MAIL_HOST=smtp.gmail.com
TINA4_MAIL_PORT=587
TINA4_MAIL_USERNAME=you@gmail.com
TINA4_MAIL_PASSWORD=app-password-here
TINA4_MAIL_FROM=you@gmail.com
TINA4_MAIL_ENCRYPTION=tls          # ssl | tls | starttls | none (default tls)

TINA4_MAIL_IMAP_HOST=imap.gmail.com
TINA4_MAIL_IMAP_PORT=993
TINA4_MAIL_IMAP_ENCRYPTION=tls     # tls | ssl | starttls | none (default tls)
```

With no `TINA4_MAIL_HOST` (or with `TINA4_MAIL_CAPTURE=true`) mail is captured in the dev mailbox
instead of being sent.

## Send Email

```typescript
import { Messenger } from "tina4-nodejs";

const mail = new Messenger();

// send(to, subject, body, html?, text?, cc?, bcc?, replyTo?, attachments?, headers?)
await mail.send("user@example.com", "Hello", "Plain text message");

// HTML with a plain-text alternative
await mail.send("user@example.com", "Welcome", "<h1>Welcome!</h1>", true, "Welcome!");

// Multiple recipients, CC, BCC, Reply-To, an attachment (file path)
await mail.send(
    ["alice@test.com", "bob@test.com"], "Team Update", "See attached.", false, undefined,
    ["manager@test.com"], ["archive@test.com"], "noreply@test.com", ["/path/to/report.pdf"],
);
```

`send()` returns `{ success, message, id }` and never throws for a delivery failure.

## Read Email (IMAP)

```typescript
const mail = new Messenger();

const messages = await mail.inbox("INBOX", 20);          // inbox(folder, limit, offset)
const count = await mail.unread();                       // unread message count
const msg = await mail.read("123");                      // by IMAP UID
// { uid, subject, from, to, cc, date, bodyText, bodyHtml, attachments, headers }

// search(folder, subject?, sender?, since?, before?, unseenOnly?, limit?)
const results = await mail.search("INBOX", "invoice", "billing@", "2024-01-01", undefined, true);

await mail.markRead("123");
await mail.markUnread("123");
await mail.delete("123");
const folders = await mail.folders();
```

A connection, login or protocol failure raises `MessengerConnectionError`; an empty mailbox is `[]`.

## Test Connection

```typescript
const mail = new Messenger();
await mail.testConnection();       // SMTP, same transport rules as send()
await mail.testImapConnection();   // IMAP
```

## Encryption (ADR-0071)

| `TINA4_MAIL_ENCRYPTION` | Port 465 | Any other port |
|---|---|---|
| `ssl` | implicit TLS | implicit TLS |
| `tls` / `starttls` (default `tls`) | implicit TLS | STARTTLS, **required**: the send fails before AUTH if the server does not offer it |
| `none` | implicit TLS | plaintext, never upgraded |

- An unknown value (a typo like `tsl`) raises when the Messenger is built; it never falls back to
  cleartext. The same goes for `TINA4_MAIL_IMAP_ENCRYPTION`.
- Certificates are always verified, host name included, for SMTP and IMAP. There is no switch to
  turn that off. To trust a private CA (a lab or company relay), start Node with
  `NODE_EXTRA_CA_CERTS=/path/ca.pem`.

## Key Rules

- For slow sends (bulk email), push to a Queue and process asynchronously
- Use app passwords for Gmail (not your real password)
- All email handling uses Node.js built-in modules — zero dependencies
