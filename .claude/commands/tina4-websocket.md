# Set Up Tina4 WebSocket Communication

Create real-time WebSocket endpoints using the built-in RFC 6455 implementation.

## Instructions

1. Register WebSocket route handlers
2. Use the connection manager for broadcasting
3. Integrate with the main server

## WebSocket Route (`src/routes/ws.ts`)

```typescript
import { WebSocketServer, WebSocketConnection } from "tina4-nodejs";

const ws = new WebSocketServer();

ws.route("/ws/chat", async (conn: WebSocketConnection, message: string) => {
    const data = JSON.parse(message);

    if (data.type === "join") {
        await conn.manager.broadcast(
            JSON.stringify({ type: "joined", user: data.user }),
            "/ws/chat",
        );
    } else if (data.type === "message") {
        await conn.manager.broadcast(
            JSON.stringify({ type: "message", user: data.user, text: data.text }),
            "/ws/chat",
        );
    }
});

ws.route("/ws/notifications", async (conn: WebSocketConnection, message: string) => {
    // Handle notification subscriptions
});
```

## Connection Manager

```typescript
import { WebSocketManager } from "tina4-nodejs";

const manager = new WebSocketManager();

// Broadcast to all connections on a path
await manager.broadcast("Hello everyone!", "/ws/chat");

// Send to a specific connection
const conn = manager.getById(connectionId);
if (conn) {
    await conn.send("Private message");
}

// Get all connections on a path
const connections = manager.getByPath("/ws/chat");

// Connection count
const count = manager.connections.length;
```

## Client-Side (JavaScript)

```javascript
const ws = new WebSocket("ws://localhost:7145/ws/chat");

ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", user: "Alice" }));
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log(data);
};

ws.onclose = () => console.log("Disconnected");
```

## WebSocket Features

```typescript
// Connection properties
conn.id          // Unique connection ID
conn.path        // Route path (e.g., "/ws/chat")
conn.ip          // Client IP address
conn.closed      // Boolean — is connection closed?

// Send/receive
await conn.send("text message");
await conn.send(Buffer.from("binary data"));
await conn.close(1000, "Normal closure");

// Frame types supported
// - Text (opcode 0x1)
// - Binary (opcode 0x2)
// - Close (opcode 0x8)
// - Ping (opcode 0x9) — auto-responded with Pong
// - Pong (opcode 0xA)
// - Fragmented messages (auto-reassembled)
```

## Environment Config

```bash
TINA4_WS_MAX_FRAME_SIZE=1048576    # Max frame size in bytes (default 1MB)
TINA4_WS_MAX_CONNECTIONS=1000      # Max concurrent connections
```

## Key Rules

- WebSocket routes go in `src/routes/` like HTTP routes
- Always use JSON for structured messages
- Use path-based routing to separate concerns (chat, notifications, etc.)
- The server handles ping/pong automatically — no keepalive code needed
- Connection cleanup is automatic when clients disconnect
