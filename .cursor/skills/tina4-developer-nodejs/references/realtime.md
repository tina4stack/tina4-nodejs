# Realtime collaboration (`realtime()`) — Node reference

Real-time collaboration control plane for Tina4 Node: a WebRTC **signalling relay** (mesh,
peer-to-peer), persistent **chat** (channels / messages / presence / typing / read receipts), and
**file** upload/download. Tina4 carries no media — it only relays the WebRTC offer/answer/ICE
handshake; it never parses the SDP. Zero dependencies (S3 storage is the one opt-in).

- **Source of truth:** `packages/orm/src/realtime/realtime.ts` (+ `models/`, `storage.ts`, `index.ts`).
- **Import from the ORM package** — the whole surface is exported from `tina4-nodejs/orm`:
  ```typescript
  import { realtime, iceServers, selectStorage, storageKey,
           LocalStorage, S3Storage, type RealtimeOptions, type StorageBackend } from "tina4-nodejs/orm";
  ```
  The framework-owned models are exported with a `Realtime`-prefixed alias:
  `RealtimeWorkspace`, `RealtimeChannel`, `RealtimeChannelMember`, `RealtimeMessage`,
  `RealtimeAttachment`.

**This is the backend.** The browser client that consumes it (offer/answer, `getUserMedia`, the chat
socket UI) belongs to the **`tina4-js`** skill's **`rtc`** module — it fetches `/api/rtc/config` and
drives these WebSockets. Build the server here; build the client there.

Everything below is verified against `realtime.ts`. Where Node differs from the Python master, it's
flagged — the wire contract (paths, JSON shapes, env vars, `tina4_rt_*` tables) is otherwise identical.

---

## Mounting: `await realtime(options?)`

Call once in `app.ts` **before `startServer()`**. It creates the chat tables (when needed), registers
routes, and returns the resolved path map (also served from the config endpoint, so the client
discovers paths and never hardcodes a URL).

> **`realtime()` is `async` in Node — `await` it.** (The Python master's `realtime()` is sync; Node's
> ORM table creation is async, so mount returns a `Promise`.) Route registration itself is synchronous;
> the `await` is so the `tina4_rt_*` tables exist before the first request.

```typescript
// app.ts
import { startServer } from "tina4-nodejs";
import { initDatabase } from "tina4-nodejs/orm";
import { realtime } from "tina4-nodejs/orm";

await initDatabase({ url: process.env.TINA4_DATABASE_URL! });   // bind the DB FIRST (see Footguns)

await realtime();                                             // calls only (default)
await realtime({ features: ["calls", "chat"] });             // add persistent chat
await realtime({ prefix: "/api/collab", features: ["calls", "chat", "files"] });  // relocate everything

startServer();
```

### `RealtimeOptions`

| option | meaning |
|---|---|
| `prefix` | mounts the whole surface under `/<prefix>` (default: root). Leading/trailing slashes are stripped: `"/api/collab/"` → `/api/collab`. |
| `authorize` | membership guard `authorize(identity, channelId) -> boolean \| Promise<boolean>` (sync **or** async) used by `chat`/`files`. Defaults to a `ChannelMember` membership check. `identity` is the **string** user id from the JWT. |
| `storage` | a `StorageBackend` for the `files` feature. Defaults to the env-selected store (`local`). |
| `features` | string array; any of `"calls"`, `"chat"`, `"files"`. **Default `["calls"]`.** |

> **No `media` option in Node.** The Python master takes `media=` to swap the media backend; the Node
> port has **no** media-backend param and no `RtcMediaBackend`/`mint_join`. The backend is hardcoded
> `"mesh"` everywhere (same shortcut the PHP port takes), and `TINA4_RTC_BACKEND` is **not** read. An
> SFU/LiveKit backend is a future drop-in, not a current option.

### What it returns — the resolved path map

The returned map holds the **base** paths; the config endpoint body adds the `{room}`/`{channel}`/`{id}`
template tokens the client fills in.

```typescript
await realtime()
// → { backend: "mesh", config: "/api/rtc/config", signalling: "/ws/rtc" }

await realtime({ features: ["calls", "chat"] })
// → { backend, config, signalling: "/ws/rtc", chat: "/ws/chat", messages: "/api/channels" }

await realtime({ features: ["files"] })
// → { backend, config, files: "/api/files" }
```

`config` is added by **any** enabled feature (`calls` sets it; `chat`/`files` add it with `??=`), so
even a chat-only or files-only mount exposes `/api/rtc/config`.

### What it wires (per feature)

| feature | routes registered | auth |
|---|---|---|
| any | `GET  {p}/api/rtc/config` | **public** (no `.secure()`) |
| `calls` | `WS   {p}/ws/rtc/{room}` | **public** (unauthenticated — no `secured`) |
| `chat` | `WS   {p}/ws/chat/{channel}` | **secured** — `Router.websocket(..., { secured: true })`; valid JWT required on upgrade |
| `chat` | `GET  {p}/api/channels/{id}/messages` | `.secure()` |
| `files` | `POST {p}/api/files` | auth-required (Tina4 secures write routes by default) |
| `files` | `GET  {p}/api/files/{key}` | `.secure()` |

If `chat` or `files` is enabled, `ensureChatTables()` runs at mount (see Footguns).

---

## `GET {p}/api/rtc/config` — public

The bootstrap the frontend fetches (the `tina4-js` `rtc` module) so client and server never drift.
Body is feature-gated — only keys for enabled features appear, and it's where the template tokens live:

```jsonc
{
  "backend": "mesh",
  "iceServers": [ /* iceServers() */ ],        // calls
  "signalling": "/ws/rtc/{room}",              // calls
  "chat": "/ws/chat/{channel}",                // chat
  "messages": "/api/channels/{id}/messages",   // chat
  "files": "/api/files"                          // files
}
```

---

## `iceServers()`

Exported. Builds the ICE server list from env. **Always** includes a STUN entry. Adds a TURN entry
with time-limited coturn `use-auth-secret` credentials **only when both** `TINA4_RTC_TURN_URL` and
`TINA4_RTC_TURN_SECRET` are set.

TURN credential scheme: `username = String(Math.floor(Date.now()/1000) + ttl)`,
`credential = HMAC_SHA1(secret, username)` base64-encoded (`node:crypto` `createHmac`).

```jsonc
// no TURN env:
[ { "urls": ["stun:stun.l.google.com:19302"] } ]

// TINA4_RTC_TURN_URL + TINA4_RTC_TURN_SECRET set:
[ { "urls": ["stun:stun.l.google.com:19302"] },
  { "urls": ["turn:turn.example.com:3478"], "username": "1783546725", "credential": "ie7Mm…==" } ]
```

### ICE / TURN env

| var | default | effect |
|---|---|---|
| `TINA4_RTC_STUN_URLS` | `stun:stun.l.google.com:19302` | comma-separated STUN URLs. |
| `TINA4_RTC_TURN_URL` | — | comma-separated TURN URLs; enables TURN when set with the secret. |
| `TINA4_RTC_TURN_SECRET` | — | coturn `use-auth-secret` shared secret (ephemeral creds). |
| `TINA4_RTC_TURN_TTL` | `3600` | ephemeral TURN credential lifetime (seconds). |

(`TINA4_RTC_BACKEND` is **not** read in Node — the backend is always `mesh`.)

---

## Signalling WS: `{p}/ws/rtc/{room}` — public

Registered by `calls`. **Not secured — anyone can join any room** (see Footguns). Uses the framework
WebSocket handler convention `(connection, event, data)`:

```typescript
(connection, event, data) => { /* event: "open" | "message" | "close"; data is the string frame */ }
```

Mesh relay behavior:

- `room = connection.params.room ?? ""`; empty room → returns (no-op).
- `event === "open"` → `connection.joinRoom("rtc:" + room)`.
- `event === "message"` → `connection.broadcastToRoom("rtc:" + room, data, true)` — relays the **raw**
  frame to the other peers (`excludeSelf = true`). Tina4 never parses the SDP; peers filter by a `to`
  field themselves.

Rooms are namespaced `rtc:<room>` so signalling rooms never collide with chat channels (`chat:<id>`)
that share the WebSocket manager.

`WebSocketConnection` surface used (camelCase in Node): `connection.params`, `connection.auth`,
`connection.joinRoom(name)`, `connection.broadcastToRoom(name, message, excludeSelf)`,
`connection.sendJson(obj)`, `connection.close()`, `connection.getRoomConnections(key)`.

---

## Chat WS: `{p}/ws/chat/{channel}` — secured

`Router.websocket(path, chatHandler, { secured: true })` — a **valid JWT is required on the upgrade**;
an unauthenticated upgrade is rejected before the handler runs.

- Channel is addressed by **integer id**: `connection.params.channel` must match `/^\d+$/`. A
  non-integer channel makes the handler return silently — the socket opens and does nothing.
- `identity = identityOf(connection.auth)` (see Auth).
- Room key is `chat:<channelId>`.

Event flow — all inbound frames are JSON; broadcasts are `JSON.stringify(...)` strings:

| event / message `type` | server behavior |
|---|---|
| `open` | authorize; **fail →** `sendJson({ type: "error", error: "not a member of this channel" })` then `close()`. **ok →** `joinRoom`, send the caller the roster `{ type: "presence", event: "roster", users: [...] }`, then broadcast `{ type: "presence", event: "join", user_id }` (exclude self). |
| `close` | broadcast `{ type: "presence", event: "leave", user_id }` (exclude self). |
| message `typing` | broadcast `{ type: "typing", user_id }` (exclude self). |
| message `read` | advance the member's read cursor (`last_read_at = now`), broadcast `{ type: "read", user_id, at: <iso> }` (exclude self). |
| message `message` | trim `body`; empty → ignored. Persist a `Message` row; on success broadcast `{ type: "message", message: <saved> }` to **everyone including the sender** (so the sender's optimistic message reconciles with its server `id` + `created_at`). |

- `type` defaults to `"message"` when absent. Unknown `type` values are ignored.
- The roster is the sorted set of distinct identities currently in the room (from each live
  connection's `auth`).
- **Authorization is re-checked on every inbound frame**, not just on join — membership can be revoked
  mid-session, and the server never trusts an identity carried in the payload.

Saved-message JSON shape (also returned by history):

```jsonc
{ "id": 12, "channel_id": 3, "user_id": "7", "body": "hi",
  "thread_id": null, "created_at": "2026-07-08T10:00:00Z" }
```

`thread_id` is `null` for a top-level message, or the parent message id for a threaded reply.

---

## Chat history: `GET {p}/api/channels/{id}/messages` — `.secure()`

Catch-up-on-reconnect endpoint.

- Identity comes from **`req.user`** (the verified JWT payload the router attached on the secured
  route). Invalid channel id → `400 { error: "invalid channel id" }`; not authorized → `403 { error: "forbidden" }`.
- Query params: `before` (return messages with `id < before`) and `limit` (default **50**, clamped to
  **1–200**).
- Returns messages **newest-first** — the standard infinite-scroll-backwards shape. Each item has the
  saved-message JSON shape above.

---

## Files: upload / download

Enabled by adding `"files"` to `features`. Uses a `StorageBackend` (the `storage` option or the
env-selected store, default `LocalStorage`).

### `POST {p}/api/files` — upload (auth-required)

- Multipart: file field **`file`** (`req.files.file`), plus form field **`channel_id`** (required,
  integer — read from body / query / params).
- Missing/invalid `channel_id` → `400`; not a channel member → `403`; no file → `400`.
- Stores the blob under an opaque, collision-free `storageKey` (16 random bytes hex + sanitized
  extension — never a user-controlled path), inserts an `Attachment` row (metadata only), and responds
  **`201`** with:

```jsonc
{ "id": 4, "key": "<storageKey>", "filename": "report.pdf", "mime": "application/pdf",
  "size": 20481, "url": "<direct url OR {files}/{key}>" }
```

`url` is `store.url(key)` when the backend exposes a direct URL (e.g. S3 presigned), else the app
download route `{files}/{key}`.

### `GET {p}/api/files/{key}` — download (`.secure()`)

- Looks up the `Attachment` by `storage_key`; missing → `404`. Authorizes against the attachment's
  `channel_id`; non-member → `403`.
- If the backend has a direct URL → **`302`** redirect (`res.redirect(url, 302)`). Otherwise **streams
  the bytes** (`200`) with `Content-Disposition: inline; filename="…"` and the attachment's `mime`
  (default `application/octet-stream`). Missing bytes → `404`.

### Storage backends (`storage.ts`)

`selectStorage(storage?)` resolves from the `storage` argument or `TINA4_STORAGE_BACKEND`
(`local` default | `s3`). An `s3` backend that can't be built (**`@aws-sdk/client-s3`** missing or
config incomplete) **falls back to `LocalStorage`** with a warning — a real store, never a silent
no-op.

> **Node uses `@aws-sdk/client-s3` (+ `@aws-sdk/s3-request-presigner`), not boto3.** It's an optional
> peer dependency loaded lazily; install it only if you set `TINA4_STORAGE_BACKEND=s3`.

| var | default | effect |
|---|---|---|
| `TINA4_STORAGE_BACKEND` | `local` | `local` \| `s3`. |
| `TINA4_STORAGE_DIR` | `data/rt_storage` | local filesystem directory. |
| `TINA4_STORAGE_URL` | — | S3 endpoint URL (S3-compatible / MinIO); `forcePathStyle: true`. |
| `TINA4_STORAGE_KEY` / `TINA4_STORAGE_SECRET` | — | S3 credentials. |
| `TINA4_STORAGE_BUCKET` | — | S3 bucket (required for S3; missing → constructor throws → falls back to local). |
| `TINA4_STORAGE_REGION` | `us-east-1` | S3 region. |

`LocalStorage` resolves every key inside its root and rejects path traversal; `url()` returns `null`
(files are served by the permissioned download route). `S3Storage.url()` returns a presigned GET URL
(default TTL 3600s) so clients fetch large blobs straight from object storage.

---

## Auth & identity

- **`identityOf(auth)`** — extracts a stable **string** user id from a verified JWT payload, trying
  claims **`user_id` → `sub` → `id`** in order; returns `null` if `auth` is not an object or none of
  those claims are present. Identities round-trip as strings, so an int id, a UUID, or an email all
  work.
- **WS identity** comes from `connection.auth` (the verified payload the router attached on the secured
  upgrade). **HTTP identity** comes from **`req.user`** inside each handler.
  > This is the Node/PHP convention — the router validates the JWT on the secured / auth-required route
  > and attaches `req.user`. (The Python master re-parses the `Authorization` header via
  > `authenticate_request` in each HTTP handler; Node does not.)
- **Default authorization** — the user must be a member of the channel:
  `ChannelMember.count("channel_id = ? AND user_id = ?", [channelId, identity]) > 0`. Any exception is
  logged and returns `false` (deny).
- **`authorize` overrides it** — pass `authorize(identity, channelId) -> boolean | Promise<boolean>`
  (sync or async; a promise is awaited). Use it to, e.g., open public channels to any authenticated
  user. It short-circuits to `false` when `identity` is `null`, so an unauthenticated caller is always
  denied regardless of the guard. It runs on **every** inbound chat frame — keep it cheap.

---

## Data model (`packages/orm/src/realtime/models/`)

Framework-owned `BaseModel` classes, all with the **`tina4_rt_`** table prefix so they never collide
with an app's own tables. Created on demand at mount via `ensureChatTables()` (each model's
`createTable()`), in dependency order: `Workspace, Channel, ChannelMember, Message, Attachment`.

| model | table | key fields |
|---|---|---|
| `Workspace` (`RealtimeWorkspace`) | `tina4_rt_workspaces` | `id`, `name`, `created_at` |
| `Channel` (`RealtimeChannel`) | `tina4_rt_channels` | `id`, `workspace_id`, `name`, `kind` (`public`\|`private`\|`dm`, default `public`), `created_at` |
| `ChannelMember` (`RealtimeChannelMember`) | `tina4_rt_channel_members` | `id`, `channel_id`, `user_id` (string, ≤128), `role` (default `member`), `last_read_at` (read cursor) |
| `Message` (`RealtimeMessage`) | `tina4_rt_messages` | `id`, `channel_id`, `user_id` (string), `body` (text), `thread_id` (nullable parent id), `created_at`, `edited_at` (nullable) |
| `Attachment` (`RealtimeAttachment`) | `tina4_rt_attachments` | `id`, `channel_id`, `message_id` (nullable), `storage_key`, `filename`, `mime`, `size`, `thumb_key` (nullable) |

`user_id` is a **string** everywhere so any JWT identity shape (int id / UUID / email) fits. Create
channels + memberships with these models (or your own admin flow) before clients connect — the mount
seeds no data.

---

## ⚠️ Footguns / hard rules

- **Bind a database BEFORE `realtime({ features: ["chat" | "files"] })`.** `ensureChatTables()` runs at
  mount, but a failure (no DB bound) is **caught, logged as an ERROR, and boot continues** — `realtime`
  still returns the full path map and registers every route; the failure only resurfaces at query time.
  Call `initDatabase({ url })` / `bindDatabase(db)` first, then `await realtime(...)`.
- **`realtime()` is async — always `await` it.** Skipping the `await` risks the first chat/history/file
  request racing table creation.
- **The signalling WS (`/ws/rtc/{room}`) is PUBLIC** — it's not `secured`, so anyone can join any room
  and receive relayed signalling frames. Only the **chat** WS is JWT-secured. Gate call access at the
  app layer if you need it.
- **The config endpoint (`/api/rtc/config`) is PUBLIC** and returns your ICE/TURN config, including
  freshly-minted ephemeral TURN credentials.
- **WS handler signature is `(connection, event, data)`** — `event` is `"open"`/`"message"`/`"close"`,
  `data` is the string frame on `"message"`. Same order as the Python master. (The **PHP** port fires
  `($connection, $data, $event)` — order differs there, not here.)
- **Channels are addressed by integer id.** A non-integer `{channel}` makes the chat handler return
  silently (no error frame) — the client sees a socket that opens and does nothing.
- **Chat authorization is re-checked on every frame**, and identity is always taken from the verified
  token (`connection.auth` / `req.user`), never from the message payload. A custom `authorize` must be
  cheap — it runs on every inbound message.
- **A message with an empty/whitespace `body` is silently dropped** (no persist, no broadcast).
  `read` / `typing` / unknown types never persist anything.
- **The backend is hardcoded `mesh` in Node** — there's no `media` option and `TINA4_RTC_BACKEND` is
  ignored. Only mesh (peer-to-peer, zero-dependency) ships; there is no SFU join token.
