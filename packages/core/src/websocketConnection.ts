/**
 * Represents a WebSocket connection with send/broadcast/close capabilities.
 * Used by Router.websocket() route handlers.
 */
export interface WebSocketConnection {
  /** Unique connection identifier */
  id: string;
  /** The WebSocket route path this connection is on */
  path: string;
  /** Client IP address */
  ip: string;
  /** HTTP headers from the upgrade request */
  headers: Record<string, string>;
  /** Route parameters extracted from `{param}` segments in the path */
  params: Record<string, string>;
  /**
   * Verified JWT payload on a `@secured` / `.secure()` WebSocket route, or
   * `null` on a public route (the default). Set on the upgrade after the token
   * is validated — mirrors Python's `connection.auth`.
   */
  auth: Record<string, unknown> | null;
  /** Send a message to this connection only */
  send(message: string): void;
  /** Serialize an object to JSON and send it to this connection. Parity with Python/PHP. */
  sendJson(data: unknown): void;
  /** Broadcast a message to all connections on the same path (path-scoped) */
  broadcast(message: string): void;
  /**
   * Broadcast a message to every connection in a room. Pass `excludeSelf: true`
   * to skip this connection (the common signalling/chat relay case). Mirrors
   * Python `connection.broadcast_to_room(room, msg, exclude_self=...)`.
   */
  broadcastToRoom(roomName: string, message: string, excludeSelf?: boolean): void;
  /**
   * The live connections currently in a room (for presence rosters — read each
   * returned connection's `.auth`). Mirrors the manager room enumeration used
   * by the Python/PHP/Ruby realtime rosters.
   */
  getRoomConnections(roomName: string): WebSocketConnection[];
  /** Join a room */
  joinRoom(roomName: string): void;
  /** Leave a room */
  leaveRoom(roomName: string): void;
  /** Close this connection */
  close(): void;

  // ── Callback properties (used by WebSocketServer.route() adapter) ──

  /** Internal message callback, set via onMessage(). */
  _onMessage: ((data: string) => void | Promise<void>) | null;
  /** Internal close callback, set via onClose(). */
  _onClose: (() => void | Promise<void>) | null;

  /** Register a message handler (decorator style, matches Python). */
  onMessage(handler: (data: string) => void | Promise<void>): void;
  /** Register a close handler (decorator style, matches Python). */
  onClose(handler: () => void | Promise<void>): void;
}
