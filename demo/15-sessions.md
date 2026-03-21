# Sessions

Tina4 provides file-backed session management with support for flash data, session regeneration, and configurable TTL. Zero external dependencies.

## Basic Usage

```typescript
import { Session } from "tina4-nodejs";

const session = new Session();

// Start a new session (returns session ID)
const sessionId = session.start();

// Store data
session.set("user", { name: "Alice", role: "admin" });
session.set("theme", "dark");

// Retrieve data
const user = session.get("user");           // { name: "Alice", role: "admin" }
const missing = session.get("foo", "default"); // "default" (fallback)

// Check existence
session.has("user");  // true

// Get all non-internal data
session.all();  // { user: {...}, theme: "dark" }

// Delete a key
session.delete("theme");

// Destroy the entire session
session.destroy();
```

## Resuming a Session

```typescript
const session = new Session();

// Resume an existing session by ID
const sessionId = session.start("abc123def456...");
// If the session file exists and hasn't expired, it's loaded.
// If expired or not found, a new session is created.
```

## Session in a Route Handler

```typescript
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { Session } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const session = new Session();

  // Extract session ID from cookie
  const cookies = parseCookies(req.headers.cookie ?? "");
  const sessionId = session.start(cookies.session_id);

  // Set the session cookie
  res.cookie("session_id", sessionId, {
    httpOnly: true,
    path: "/",
    maxAge: 3600,
    sameSite: "Lax",
  });

  // Use session data
  const visits = (session.get("visits", 0) as number) + 1;
  session.set("visits", visits);

  res.json({ visits, sessionId });
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}
```

## Flash Data

Flash data is automatically deleted after the first read. Useful for one-time messages like form validation errors or success notifications.

```typescript
const session = new Session();
session.start();

// Set flash data
session.flash("success", "Your profile has been updated!");

// Read flash data (auto-deleted after read)
const message = session.getFlash("success");  // "Your profile has been updated!"
const again = session.getFlash("success");     // undefined (already consumed)
```

## Session Regeneration

Regenerate the session ID while keeping the data. Useful after login to prevent session fixation attacks.

```typescript
const session = new Session();
session.start(existingSessionId);

// Regenerate ID (old file deleted, new file created)
const newSessionId = session.regenerate();
```

## Configuration

```typescript
import { Session } from "tina4-nodejs";
import type { SessionConfig } from "tina4-nodejs";

const session = new Session("file", {
  backend: "file",           // Currently only "file" is supported
  path: "data/sessions",     // Storage directory (default: "data/sessions")
  ttl: 7200,                 // Session lifetime in seconds (default: 3600)
});
```

### Environment Variables

```bash
# .env
TINA4_SESSION_BACKEND=file
TINA4_SESSION_PATH=data/sessions
TINA4_SESSION_TTL=7200
```

## Storage

Sessions are stored as JSON files in the configured directory:

```
data/sessions/
  a1b2c3d4e5f6.json
  f7e8d9c0b1a2.json
```

Each file contains the session data plus internal timestamps:

```json
{
  "_created": 1711000000,
  "_accessed": 1711003600,
  "user": { "name": "Alice" },
  "theme": "dark"
}
```

## Expiration

Sessions expire based on the `_accessed` timestamp. When `start()` is called with an expired session ID, the old file is deleted and a new session is created.
