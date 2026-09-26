# Feature 140: Web Push

Web Push is a standalone outbound integration. It is not WebSocket, Server-Sent Events, or a realtime backplane.

Enable it with configuration:

```env
TINA4_WEB_PUSH=true
TINA4_VAPID_SUBJECT=mailto:ops@example.com
TINA4_VAPID_PUBLIC=<base64url P-256 public key>
TINA4_VAPID_PRIVATE=<base64url P-256 private key>
```

Node.js uses the built-in crypto and fetch APIs. It needs no extra Web Push package. When Web Push is configured without complete keys, it fails loudly.

```ts
import { Push } from "tina4-nodejs";

const sender = new Push(); // reads TINA4_VAPID_* from the environment
const result = await sender.send(subscription, { title: "Order ready", body: "Order 123 is ready" });
```

The sender produces VAPID ES256 authorization and RFC 8291 `aes128gcm` payloads. The result exposes `ok`, `status`, `dead`, `retryable`, `endpoint`, and `response`; HTTP 404/410 are dead subscriptions, while 408, 429, and 5xx are retryable.
