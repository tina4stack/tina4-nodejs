import { createHmac } from "node:crypto";
import {
  Router,
  HTTP_OK,
  HTTP_CREATED,
  HTTP_BAD_REQUEST,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  Log,
  type WebSocketConnection,
  type Tina4Request,
  type Tina4Response,
} from "../../../core/src/index.js";
import Workspace from "./models/workspace.js";
import Channel from "./models/channel.js";
import ChannelMember from "./models/channelMember.js";
import Message from "./models/message.js";
import Attachment from "./models/attachment.js";
import { selectStorage, storageKey, type StorageBackend } from "./storage.js";

/**
 * Real-time collaboration mount for Tina4 (Node), parity with the Python
 * master's tina4_python.realtime. A zero-dependency control plane:
 *
 * - calls: a WebRTC signalling relay (mesh) + self-describing ICE-config
 *   endpoint. Tina4 carries no media, it only relays the offer/answer/ICE
 *   handshake; peers filter by `to`.
 * - chat: persistent channels + messages (framework-owned ORM models), a
 *   secured chat WebSocket with live presence / typing / read receipts, and a
 *   history endpoint for catch-up-on-reconnect.
 * - files: permissioned upload/download through a pluggable StorageBackend.
 *
 * The wire contract (paths, JSON shapes, env vars, tina4_rt_* tables) is
 * byte-identical to the master. The WS handler is (connection, event, data)
 * with a string event; identity comes from connection.auth (WS) and req.user
 * (HTTP - the router validated the JWT on the secured/auth-required route).
 */

const DEFAULT_STUN = "stun:stun.l.google.com:19302";

export interface RealtimeOptions {
  prefix?: string;
  authorize?: (identity: string, channelId: number) => boolean | Promise<boolean>;
  storage?: StorageBackend;
  features?: string[];
}

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Build the ICE server list from the environment (STUN always; ephemeral TURN when configured). */
export function iceServers(): IceServer[] {
  const stun = process.env.TINA4_RTC_STUN_URLS || DEFAULT_STUN;
  const servers: IceServer[] = [{ urls: splitUrls(stun) }];

  const turnUrl = process.env.TINA4_RTC_TURN_URL;
  const secret = process.env.TINA4_RTC_TURN_SECRET;
  if (turnUrl && secret) {
    const ttl = parseInt(process.env.TINA4_RTC_TURN_TTL || "3600", 10);
    const username = String(Math.floor(Date.now() / 1000) + ttl);
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    servers.push({ urls: splitUrls(turnUrl), username, credential });
  }
  return servers;
}

let _authorize: RealtimeOptions["authorize"] | undefined;

/**
 * Mount the realtime surface and return the resolved path map (also served
 * from the config endpoint so the client can discover it).
 *
 * Returns a Promise because the framework-owned chat tables are created via the
 * async ORM (Node's DB layer is async) - `await realtime(...)` so the tables
 * exist before the first request. Route registration itself is synchronous.
 */
export async function realtime(options: RealtimeOptions = {}): Promise<Record<string, string>> {
  const features = options.features ?? ["calls"];
  const raw = (options.prefix ?? "").replace(/^\/+|\/+$/g, "");
  const p = raw ? `/${raw}` : "";
  _authorize = options.authorize;

  if (features.includes("chat") || features.includes("files")) {
    await ensureChatTables();
  }

  const paths: Record<string, string> = { backend: "mesh" };
  if (features.includes("calls")) {
    paths.config = `${p}/api/rtc/config`;
    paths.signalling = `${p}/ws/rtc`;
  }
  if (features.includes("chat")) {
    paths.config ??= `${p}/api/rtc/config`;
    paths.chat = `${p}/ws/chat`;
    paths.messages = `${p}/api/channels`;
  }
  if (features.includes("files")) {
    paths.config ??= `${p}/api/rtc/config`;
    paths.files = `${p}/api/files`;
  }

  if (paths.config) registerConfig(paths, features);
  if (features.includes("calls")) registerCalls(paths);
  if (features.includes("chat")) registerChat(paths);
  if (features.includes("files")) registerFiles(paths, options.storage);

  return paths;
}

// ── route registration ──────────────────────────────────────────────

function registerConfig(paths: Record<string, string>, features: string[]): void {
  Router.get(paths.config, async (_req: Tina4Request, res: Tina4Response) => {
    const body: Record<string, unknown> = { backend: "mesh" };
    if (features.includes("calls")) {
      body.iceServers = iceServers();
      body.signalling = `${paths.signalling}/{room}`;
    }
    if (features.includes("chat")) {
      body.chat = `${paths.chat}/{channel}`;
      body.messages = `${paths.messages}/{id}/messages`;
    }
    if (features.includes("files")) body.files = paths.files;
    return res.json(body, HTTP_OK);
  });
}

function registerCalls(paths: Record<string, string>): void {
  // WebRTC signalling relay (mesh). Public room; Tina4 never parses the SDP,
  // peers filter by `to`. The room id comes from the {room} path param.
  Router.websocket(`${paths.signalling}/{room}`, (connection, event, data) => {
    const room = connection.params.room ?? "";
    if (!room) return;
    const key = `rtc:${room}`;
    if (event === "open") {
      connection.joinRoom(key);
    } else if (event === "message") {
      connection.broadcastToRoom(key, data, true);
    }
  });
}

function registerChat(paths: Record<string, string>): void {
  Router.websocket(`${paths.chat}/{channel}`, chatHandler, { secured: true });

  Router.get(`${paths.messages}/{id}/messages`, async (req: Tina4Request, res: Tina4Response) => {
    const identity = identityOf(req.user);
    const channelId = parseInt(String(req.params.id ?? ""), 10);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.json({ error: "invalid channel id" }, HTTP_BAD_REQUEST);
    }
    if (!(await authorized(identity, channelId))) {
      return res.json({ error: "forbidden" }, HTTP_FORBIDDEN);
    }
    return res.json(await history(channelId, req.query ?? {}), HTTP_OK);
  }).secure();
}

function registerFiles(paths: Record<string, string>, storageOpt?: StorageBackend): void {
  const store = selectStorage(storageOpt);

  // POST is auth-required by default (mirrors GET being public).
  Router.post(paths.files, async (req: Tina4Request, res: Tina4Response) => {
    const identity = identityOf(req.user);
    const channelId = parseInt(String(formValue(req, "channel_id") ?? ""), 10);
    if (!Number.isFinite(channelId) || channelId <= 0) {
      return res.json({ error: "channel_id is required" }, HTTP_BAD_REQUEST);
    }
    if (!(await authorized(identity, channelId))) {
      return res.json({ error: "forbidden" }, HTTP_FORBIDDEN);
    }
    const upload = req.files?.file;
    const file = Array.isArray(upload) ? upload[0] : upload;
    if (!file) return res.json({ error: "no file uploaded (field 'file')" }, HTTP_BAD_REQUEST);

    const saved = await storeUpload(store, channelId, file as { filename?: string; type?: string; content?: Buffer });
    const direct = await store.url(saved.key);
    saved.url = direct || `${paths.files}/${saved.key}`;
    return res.json(saved, HTTP_CREATED);
  });

  Router.get(`${paths.files}/{key}`, async (req: Tina4Request, res: Tina4Response) => {
    const identity = identityOf(req.user);
    const key = String(req.params.key ?? "");
    const rows = await Attachment.where("storage_key = ?", [key], 1);
    const att = rows[0] as { channel_id?: number; filename?: string; mime?: string } | undefined;
    if (!att) return res.json({ error: "not found" }, HTTP_NOT_FOUND);
    if (!(await authorized(identity, Number(att.channel_id)))) {
      return res.json({ error: "forbidden" }, HTTP_FORBIDDEN);
    }
    const direct = await store.url(key);
    if (direct) return res.redirect(direct, 302);
    const bytes = await store.get(key);
    if (bytes === null) return res.json({ error: "not found" }, HTTP_NOT_FOUND);
    res.header("Content-Disposition", `inline; filename="${att.filename || key}"`);
    return res.send(bytes, HTTP_OK, att.mime || "application/octet-stream");
  }).secure();
}

// ── WebSocket chat handler ────────────────────────────────────────────

async function chatHandler(connection: WebSocketConnection, event: "open" | "message" | "close", data: string): Promise<void> {
  const rawChannel = connection.params.channel ?? "";
  if (!/^\d+$/.test(rawChannel)) return; // framework channels are addressed by integer id
  const channelId = parseInt(rawChannel, 10);
  const identity = identityOf(connection.auth);
  const key = `chat:${channelId}`;

  if (event === "open") {
    if (!(await authorized(identity, channelId))) {
      connection.sendJson({ type: "error", error: "not a member of this channel" });
      connection.close();
      return;
    }
    connection.joinRoom(key);
    connection.sendJson({ type: "presence", event: "roster", users: roster(connection, key) });
    connection.broadcastToRoom(key, JSON.stringify({ type: "presence", event: "join", user_id: identity }), true);
    return;
  }

  if (event === "close") {
    connection.broadcastToRoom(key, JSON.stringify({ type: "presence", event: "leave", user_id: identity }), true);
    return;
  }

  // Re-check membership on every inbound frame (it can be revoked mid-session).
  if (!(await authorized(identity, channelId))) return;
  const payload = parseJson(data);
  if (!payload || typeof payload !== "object") return;

  const kind = (payload as { type?: string }).type ?? "message";
  if (kind === "typing") {
    connection.broadcastToRoom(key, JSON.stringify({ type: "typing", user_id: identity }), true);
    return;
  }
  if (kind === "read") {
    await markRead(channelId, identity);
    connection.broadcastToRoom(key, JSON.stringify({ type: "read", user_id: identity, at: nowIso() }), true);
    return;
  }
  if (kind === "message") {
    const body = String((payload as { body?: unknown }).body ?? "").trim();
    if (!body) return;
    const saved = await persistMessage(channelId, identity, body, (payload as { thread_id?: unknown }).thread_id);
    // Deliver to everyone INCLUDING the sender (id + timestamp reconcile).
    if (saved) connection.broadcastToRoom(key, JSON.stringify({ type: "message", message: saved }));
  }
}

// ── helpers ───────────────────────────────────────────────────────────

/** Extract a stable string user identity from a verified JWT payload. */
function identityOf(auth: Record<string, unknown> | null | undefined): string | null {
  if (!auth || typeof auth !== "object") return null;
  for (const claim of ["user_id", "sub", "id"]) {
    const v = (auth as Record<string, unknown>)[claim];
    if (v !== undefined && v !== null) return String(v);
  }
  return null;
}

/** Shared membership guard for chat channels and file access. */
async function authorized(identity: string | null, channelId: number): Promise<boolean> {
  if (identity === null) return false;
  if (_authorize) return Boolean(await _authorize(identity, channelId));
  try {
    return (await ChannelMember.count("channel_id = ? AND user_id = ?", [channelId, identity])) > 0;
  } catch (e) {
    Log.error(`realtime chat authorize check failed: ${(e as Error).message}`);
    return false;
  }
}

/** Presence roster: the distinct authenticated identities in a room, sorted. */
function roster(connection: WebSocketConnection, key: string): string[] {
  const seen = new Set<string>();
  for (const c of connection.getRoomConnections(key)) {
    const id = identityOf(c.auth);
    if (id) seen.add(id);
  }
  return Array.from(seen).sort();
}

function formValue(req: Tina4Request, name: string): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === "object" && name in body) return body[name];
  return (req.query as Record<string, unknown> | undefined)?.[name] ?? (req.params as Record<string, unknown> | undefined)?.[name];
}

function parseJson(data: string): unknown {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function persistMessage(channelId: number, identity: string | null, body: string, threadId: unknown): Promise<Record<string, unknown> | null> {
  const thread = threadId === null || threadId === undefined || threadId === "" ? null : parseInt(String(threadId), 10);
  const createdAt = nowIso();
  const msg = new Message({
    channel_id: channelId,
    user_id: String(identity),
    body,
    thread_id: thread,
    created_at: createdAt,
  });
  if ((await msg.save()) === false) {
    Log.error(`realtime chat: failed to persist message in channel ${channelId}`);
    return null;
  }
  return {
    id: (msg as { id?: number }).id,
    channel_id: channelId,
    user_id: String(identity),
    body,
    thread_id: thread,
    created_at: createdAt,
  };
}

async function markRead(channelId: number, identity: string | null): Promise<void> {
  try {
    const rows = await ChannelMember.where("channel_id = ? AND user_id = ?", [channelId, identity], 1);
    const member = rows[0] as (ChannelMember & { last_read_at?: string }) | undefined;
    if (member) {
      (member as { last_read_at?: string }).last_read_at = nowIso();
      await member.save();
    }
  } catch (e) {
    Log.error(`realtime chat: read-receipt update failed: ${(e as Error).message}`);
  }
}

/** Messages for a channel, newest-first, paged by a `before` cursor. */
async function history(channelId: number, query: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  let limit = parseInt(String(query.limit ?? "50"), 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(Math.max(limit, 1), 200);
  const before = query.before;

  let clause = "channel_id = ?";
  const params: unknown[] = [channelId];
  if (before !== undefined && before !== null && String(before) !== "") {
    clause += " AND id < ?";
    params.push(parseInt(String(before), 10));
  }

  const rows = (await Message.where(clause, params, 1000)) as Array<Record<string, unknown>>;
  rows.sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
  return rows.slice(0, limit).map((m) => ({
    id: m.id,
    channel_id: m.channel_id,
    user_id: m.user_id,
    body: m.body,
    thread_id: m.thread_id,
    created_at: m.created_at,
  }));
}

async function storeUpload(
  store: StorageBackend,
  channelId: number,
  upload: { filename?: string; type?: string; content?: Buffer },
): Promise<Record<string, unknown> & { key: string; url?: string }> {
  const filename = upload.filename || "file";
  const mime = upload.type || "application/octet-stream";
  const content = upload.content ?? Buffer.alloc(0);
  const key = storageKey(filename);
  await store.put(key, content, mime);
  const att = new Attachment({ channel_id: channelId, storage_key: key, filename, mime, size: content.length });
  await att.save();
  return { id: (att as { id?: number }).id, key, filename, mime, size: content.length };
}

async function ensureChatTables(): Promise<boolean> {
  try {
    for (const model of [Workspace, Channel, ChannelMember, Message, Attachment]) {
      await model.createTable();
    }
    return true;
  } catch (e) {
    Log.error(
      `realtime chat could not create its tables (${(e as Error).message}). Chat needs a bound ` +
        "database - initDatabase()/bindDatabase() before realtime({ features: [...] }).",
    );
    return false;
  }
}

function splitUrls(csv: string): string[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}
