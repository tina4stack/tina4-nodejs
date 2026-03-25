# Set Up Tina4 Email (Send & Receive)

Send and read emails using the built-in Messenger module (SMTP + IMAP, stdlib only).

## Instructions

1. Configure SMTP/IMAP in `.env`
2. Use `Messenger` to send emails
3. Use `Messenger` to read emails via IMAP

## .env

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=you@gmail.com
SMTP_PASSWORD=app-password-here
SMTP_FROM=you@gmail.com

IMAP_HOST=imap.gmail.com
IMAP_PORT=993
```

## Send Email

```typescript
import { Messenger } from "tina4-nodejs";

const mail = new Messenger();

// Plain text
await mail.send({ to: "user@example.com", subject: "Hello", body: "Plain text message" });

// HTML
await mail.send({
    to: "user@example.com",
    subject: "Welcome",
    body: "<h1>Welcome!</h1><p>Thanks for signing up.</p>",
    html: true,
});

// With attachment
await mail.send({
    to: "user@example.com",
    subject: "Report",
    body: "See attached.",
    attachments: ["/path/to/report.pdf"],
});

// Multiple recipients, CC, BCC, Reply-To
await mail.send({
    to: ["alice@test.com", "bob@test.com"],
    subject: "Team Update",
    body: "...",
    cc: ["manager@test.com"],
    bcc: ["archive@test.com"],
    replyTo: "noreply@test.com",
});

// Binary attachment
await mail.send({
    to: "user@example.com",
    subject: "Image",
    body: "Here's the image.",
    attachments: [{ filename: "photo.png", data: imageBuffer, mime: "image/png" }],
});
```

## Read Email (IMAP)

```typescript
import { Messenger } from "tina4-nodejs";

const mail = new Messenger();

// Get inbox messages (default limit=10)
const messages = await mail.inbox({ limit: 20 });

// Get unread count
const count = await mail.unread();

// Read a specific message by UID
const msg = await mail.read("123");
// Returns: { uid, subject, from, to, cc, date, bodyText, bodyHtml, attachments, headers }

// Search
const results = await mail.search({
    subject: "invoice",
    sender: "billing@",
    since: "2024-01-01",
    unseenOnly: true,
});

// Mark as read/unread
await mail.markRead("123");
await mail.markUnread("123");

// Delete
await mail.delete("123");

// List folders
const folders = await mail.folders();
```

## Send from a Route

```typescript
import { Router, Messenger } from "tina4-nodejs";

Router.post("/api/contact", async (req, res) => {
    const mail = new Messenger();
    await mail.send({
        to: "support@myapp.com",
        subject: `Contact: ${req.body.subject}`,
        body: req.body.message,
        replyTo: req.body.email,
    });
    return res.json({ sent: true });
});
```

## With Templates

```typescript
import { Messenger, Template } from "tina4-nodejs";

const html = Template.render("emails/welcome.twig", { name: "Alice", link: "https://myapp.com" });
const mail = new Messenger();
await mail.send({ to: "alice@test.com", subject: "Welcome!", body: html, html: true });
```

## Test Connection

```typescript
const mail = new Messenger();
await mail.testConnection();       // Test SMTP
await mail.testImapConnection();   // Test IMAP
```

## Key Rules

- For slow sends (bulk email), push to a Queue and process asynchronously
- Use app passwords for Gmail (not your real password)
- SMTP uses STARTTLS on port 587, SSL on port 465
- IMAP always uses SSL
- All email handling uses Node.js built-in modules — zero dependencies
