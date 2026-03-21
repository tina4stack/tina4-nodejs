# Auth & JWT

Tina4 provides zero-dependency JWT token generation/verification, password hashing (PBKDF2), and an auth middleware. Everything uses Node.js built-in `crypto` -- no external libraries.

## JWT Tokens

### Generate a Token

```typescript
import { createToken } from "tina4-nodejs";

const token = createToken(
  { userId: 1, role: "admin" },  // Payload (claims)
  "my-secret-key",                // Secret
  3600,                            // Expires in seconds (default: 3600)
  "HS256",                         // Algorithm (default: "HS256")
);
// Returns: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Verify a Token

```typescript
import { validateToken } from "tina4-nodejs";

const payload = validateToken(token, "my-secret-key");
if (payload) {
  console.log(payload.userId); // 1
  console.log(payload.role);   // "admin"
} else {
  console.log("Invalid or expired token");
}
```

`validateToken` returns `null` if the token is invalid, has a bad signature, or is expired.

### Decode Without Verification

```typescript
import { getPayload } from "tina4-nodejs";

// Decode payload without checking signature or expiry
const payload = getPayload(token);
```

### Supported Algorithms

| Algorithm | Secret Type | Description |
|-----------|------------|-------------|
| `HS256` | HMAC shared secret | Default, symmetric signing |
| `RS256` | PEM private/public key | Asymmetric (RSA) signing |

## Password Hashing

Uses PBKDF2-SHA256 with random salt. Constant-time comparison prevents timing attacks.

```typescript
import { hashPassword, checkPassword } from "tina4-nodejs";

// Hash a password
const hash = hashPassword("mypassword123");
// "pbkdf2_sha256:100000:a1b2c3d4...:e5f6g7h8..."

// Verify against hash
const isValid = checkPassword("mypassword123", hash);  // true
const isWrong = checkPassword("wrongpassword", hash);   // false
```

### Hash Format

```
pbkdf2_sha256:{iterations}:{salt_hex}:{hash_hex}
```

Default: 100,000 iterations, 16-byte random salt, 32-byte derived key.

## Auth Middleware

Protect routes by requiring a valid Bearer JWT in the Authorization header.

```typescript
import { get } from "tina4-nodejs";
import { authMiddleware } from "tina4-nodejs";

// Protect a single route
get("/api/profile", async (req, res) => {
  const auth = (req as any).auth;
  res.json({ userId: auth.userId, role: auth.role });
}, [authMiddleware("my-secret-key")]);
```

### How It Works

1. Extracts the token from `Authorization: Bearer <token>`.
2. Verifies the signature and expiration.
3. Attaches the decoded payload to `(req as any).auth`.
4. Returns 401 if the header is missing, malformed, or the token is invalid.

### 401 Response

```json
{ "error": "Unauthorized" }
```

## Full Login Example

```typescript
// src/routes/api/auth/login/post.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { createToken, checkPassword } from "tina4-nodejs";
import { getAdapter } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  const db = getAdapter();
  const users = db.query<{ id: number; email: string; password_hash: string }>(
    'SELECT * FROM users WHERE email = ?',
    [email],
  );

  if (users.length === 0 || !checkPassword(password, users[0].password_hash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = createToken(
    { userId: users[0].id, email: users[0].email },
    process.env.JWT_SECRET ?? "change-me",
    86400, // 24 hours
  );

  res.json({ token });
}
```

## Protecting Route Groups

```typescript
import { Router, authMiddleware } from "tina4-nodejs";

const router = new Router();

router.group("/api/admin", (group) => {
  group.get("/dashboard", async (req, res) => {
    res.json({ stats: {} });
  });
  group.get("/users", async (req, res) => {
    res.json({ users: [] });
  });
}, [authMiddleware("my-secret-key")]);
```
