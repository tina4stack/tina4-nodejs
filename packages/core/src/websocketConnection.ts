/**
 * Represents a WebSocket connection with send/broadcast/close capabilities.
 * Used by Router.websocket() route handlers.
 */
export interface WebSocketConnection {
  /** Unique connection identifier */
  id: string;
  /** Send a message to this connection */
  send(message: string): void;
  /** Broadcast a message to all other connections on the same path */
  broadcast(message: string): void;
  /** Close this connection */
  close(): void;
  /** The WebSocket route path this connection is on */
  path: string;
}
