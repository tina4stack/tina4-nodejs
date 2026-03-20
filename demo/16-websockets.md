# WebSockets

Tina4 includes a zero-dependency RFC 6455 WebSocket server built on Node.js `node:http`. No `ws` or `socket.io` needed.

## Basic Server

```typescript
import { WebSocketServer } from "@tina4/core";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (client) => {
  console.log("Client connected:", client.id);
});

wss.on("message", (client, message) => {
  console.log(`Message from ${client.id}:`, message);

  // Echo back
  wss.send(client, `Echo: ${message}`);
});

wss.on("close", (client) => {
  console.log("Client disconnected:", client.id);
});

await wss.start();
```

## Broadcasting

Send a message to all connected clients:

```typescript
wss.on("message", (client, message) => {
  // Broadcast to all clients
  wss.broadcast(message);

  // Or broadcast to all except sender
  wss.broadcast(message, client.id);
});
```

## WebSocketClient Interface

```typescript
interface WebSocketClient {
  id: string;        // Unique connection ID (UUID)
  socket: Socket;    // Underlying TCP socket
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}
```

## Frame Protocol Support

The implementation handles the full RFC 6455 frame protocol:

- Text frames (`OP_TEXT`)
- Binary frames (`OP_BINARY`)
- Close frames (`OP_CLOSE`) with proper handshake
- Ping/Pong frames (`OP_PING`, `OP_PONG`)
- Client-to-server masking/unmasking
- Extended payload lengths (7-bit, 16-bit, 64-bit)

## Close Codes

```typescript
import { CLOSE_NORMAL, CLOSE_PROTOCOL_ERROR } from "@tina4/core";

// Clean shutdown
client.close(CLOSE_NORMAL, "Goodbye");
```

## Browser Client

```javascript
const ws = new WebSocket("ws://localhost:8080");

ws.onopen = () => {
  ws.send("Hello from browser!");
};

ws.onmessage = (event) => {
  console.log("Server says:", event.data);
};

ws.onclose = () => {
  console.log("Disconnected");
};
```

## Using with Tina4 Server

You can run the WebSocket server alongside the HTTP server:

```typescript
import { startServer, WebSocketServer } from "@tina4/core";

// Start HTTP server
const { port } = await startServer({ port: 3000 });

// Start WebSocket server on a different port
const wss = new WebSocketServer({ port: 3001 });

wss.on("message", (client, message) => {
  wss.broadcast(message);
});

await wss.start();
console.log(`WebSocket server on ws://localhost:3001`);
```

## Notes

- The WebSocket server creates its own HTTP server for the upgrade handshake.
- Each client gets a UUID assigned on connection.
- The implementation is synchronous-safe for message handling.
