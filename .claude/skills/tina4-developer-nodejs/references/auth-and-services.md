# Authentication & Services (Node.js)

## JWT Authentication

`Auth` and the standalone functions come from **core** (`tina4-nodejs`), not the ORM subpackage:

```typescript
import { Auth, getToken, validToken, hashPassword, checkPassword } from "tina4-nodejs";
```

`Auth.*` are static aliases of the same functions (`Auth.getToken`, `Auth.validToken`,
`Auth.hashPassword`, `Auth.checkPassword`, `Auth.authenticateRequest`, `Auth.getPayload`), so either
form works.

### Setup

Set a secret in `.env`:
```env
TINA4_SECRET=a-long-random-string-here     # e.g. `openssl rand -hex 32`
```

In local dev (`TINA4_DEBUG=true`) a per-machine secret is generated automatically into `.env.local`.
In CI / production you MUST set `TINA4_SECRET` yourself.

### Minting a token (login)

A login route is a **public write** — register it imperatively in `app.ts` with `.noAuth()` (a
file-based `post.ts` is secure-by-default and can't opt out):

```typescript
// app.ts
import { startServer, post, Auth, getToken } from "tina4-nodejs";
import { User } from "./src/models/User.js";

post("/api/login", async (request, response) => {
  const { email, password } = request.body as { email: string; password: string };
  const user = (await User.where("email = ?", [email]))[0];   // single row → where(...)[0]
  if (!user || !Auth.checkPassword(password, user.password as string)) {
    return response({ error: "Invalid credentials" }, 401);
  }
  const token = getToken({ userId: user.id, email: user.email });   // expiresIn is MINUTES (default 60)
  return response({ token });
}).noAuth();

startServer();
```

### Verifying a request

File-based write routes are already gated (401 without a valid Bearer). Inside a handler, recover the
verified payload with `Auth.authenticateRequest(request.headers)`:

```typescript
// src/routes/me/get.ts  — protect a GET by registering it .secure() in app.ts, OR verify here:
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { Auth } from "tina4-nodejs";
import { User } from "../../models/User.js";

export default async function (request: Tina4Request, response: Tina4Response) {
  const auth = Auth.authenticateRequest(request.headers);     // verified payload, or null
  if (!auth) return response({ error: "Unauthorized" }, 401);
  const user = await User.findById(auth.userId as number);
  return response(user);
}
```

`validToken(token)` returns the decoded payload (truthy) or `null`. `getPayload(token)` reads claims
without re-verifying.

### Password hashing

```typescript
const hash = Auth.hashPassword("mypassword");         // store this
const ok   = Auth.checkPassword("mypassword", hash);  // true
```

## Sessions

Configure the backend in `.env`:
```env
TINA4_SESSION_BACKEND=file    # file, redis, valkey, mongodb, database
```

`request.session` is available in handlers:

```typescript
request.session.set("userId", user.id);
const userId = request.session.get("userId");   // undefined if unset
request.session.delete("userId");
request.session.clear();                         // logout
```

## Queue System

Background jobs (emails, uploads, imports). `Queue` comes from `tina4-nodejs`:

```typescript
import { Queue } from "tina4-nodejs";
import type { QueueJob } from "tina4-nodejs";
```

### Producing

```typescript
const queue = new Queue({ topic: "order-emails" });
queue.produce("order-emails", { orderId: order.id, email: buyerEmail }, /* priority */ 0, /* delaySeconds */ 0);
```

`produce(topic, payload, priority = 0, delay = 0)` — higher `priority` runs first; `delay` (seconds)
defers processing.

### Consuming (a background worker)

`consume()` is an **async generator** — iterate it with `for await` and call `.complete()` on each
job:

```typescript
const queue = new Queue({ topic: "order-emails" });
for await (const job of queue.consume("order-emails")) {
  const j = job as QueueJob;
  await sendOrderEmail(j.data);
  j.complete();          // or j.fail() / j.retry()
}
```

`new Queue({ topic, backend })` also supports external backends (`"rabbitmq"`, `"kafka"`, `"mongo"`);
the default is the zero-config file-backed queue.

## Email (Messenger)

```typescript
import { Messenger } from "tina4-nodejs";

// src/routes/contact/post.ts
export default async function (request: Tina4Request, response: Tina4Response) {
  const { email } = request.body as { email: string };
  await new Messenger().send(
    email,                                   // to (string or string[])
    "Thanks for reaching out",               // subject
    "<h1>We received your message</h1>",     // body
    true,                                    // html = true
  );
  return response({ status: "sent" });
}
```

`send(to, subject, body, html?, text?, cc?, bcc?, replyTo?, attachments?, headers?)` returns
`{ success, error }`. In dev, the framework's dev mailbox captures mail (view it under `/__dev/`).

## WebSocket

WebSocket routes are registered imperatively. The handler is
`(connection, event, data)` where `event` is `"open" | "message" | "close"`:

```typescript
// app.ts
import { websocket } from "tina4-nodejs";

websocket("/ws/chat", async (connection, event, data) => {
  if (event === "message") {
    await connection.broadcast(data);        // send to all connected clients
  }
});                                          // add .secure() to require a JWT on the upgrade
```

## Events

Decouple app logic with `Events` (static, from `tina4-nodejs`):

```typescript
import { Events } from "tina4-nodejs";

Events.on("user.created", async (data: any) => {
  await new Messenger().send(data.email, "Welcome!", "<p>…</p>", true);
});

// Fire it after creating a user:
Events.emit("user.created", { id: user.id, email: user.email });
```

`Events.once(event, cb)` runs a listener once; `Events.off(event, cb?)` removes listeners. A throwing
listener is logged and does not abort the rest of `emit`.

## GraphQL

`GraphQL` (from `tina4-nodejs`) can expose an API from your models and custom resolvers registered
with `GraphQL.resolve("Query" | "Mutation" | "<Type>", "field", fn)`. The exact mounting API varies by
version — confirm signatures with the live API index (`api_class("GraphQL")`) before wiring it up.

## i18n / Localization

Translation JSON files go in `src/locales/` (`en.json`, `fr.json`, …). Set `TINA4_LOCALE=en` in
`.env`. Use in Frond templates:

```twig
{{ "welcome" | trans({"name": user.name}) }}
{{ "logout" | trans }}
```

`I18n` (from `tina4-nodejs`) exposes the same translations to code.

## Caching

Built-in, zero-dependency caching. Use `{% cache %}` blocks in Frond templates, or the cache API in
code (`cacheGet` / `cacheSet` / `responseCache` middleware, all from `tina4-nodejs`) for expensive
operations. Models also have `Model.cached(sql, params, ttl)` for TTL-cached raw queries.
