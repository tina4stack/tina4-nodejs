# Set Up Tina4 Authentication

Set up JWT authentication with login, password hashing, and route protection.

## Instructions

1. Ensure `SECRET` is set in `.env`
2. Create a users table with passwordHash column (migration)
3. Create login/register routes
4. Protect routes with auth defaults or `secured: true`

## .env

```bash
SECRET=your-secure-random-secret
```

## Migration

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Auth Routes (`src/routes/auth.ts`)

```typescript
import { Router, Auth, hashPassword, checkPassword } from "tina4-nodejs";

const auth = new Auth();

Router.post("/api/register", async (req, res) => {
    const { User } = await import("../orm/User");
    const data = req.body;

    // Check if email already exists
    const existing = new User();
    if (existing.load("email = ?", [data.email ?? ""])) {
        return res.json({ error: "Email already registered" }, 409);
    }

    const user = new User({
        name: data.name,
        email: data.email,
        passwordHash: hashPassword(data.password),
    });
    user.save();
    return res.json({ id: user.id, name: user.name }, 201);
}, {
    description: "Register a new user",
    tags: ["auth"],
    noAuth: true,
});

Router.post("/api/login", async (req, res) => {
    const { User } = await import("../orm/User");
    const email = req.body.email ?? "";
    const password = req.body.password ?? "";

    const user = new User();
    if (!user.load("email = ?", [email])) {
        return res.json({ error: "Invalid credentials" }, 401);
    }

    if (!checkPassword(user.passwordHash, password)) {
        return res.json({ error: "Invalid credentials" }, 401);
    }

    const token = auth.createToken({ userId: user.id, email: user.email, role: user.role });
    return res.json({ token });
}, {
    description: "Login and get JWT token",
    tags: ["auth"],
    noAuth: true,
});

Router.get("/api/me", async (req, res) => {
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    const payload = auth.getPayload(token);
    if (!payload) {
        return res.json({ error: "Invalid token" }, 401);
    }
    return res.json(payload);
}, {
    description: "Get current user profile",
    tags: ["auth"],
    secured: true,
});
```

## How Auth Works

- **GET routes** are public by default
- **POST/PUT/PATCH/DELETE routes** require `Authorization: Bearer <token>` by default
- Use `noAuth: true` on write routes that should be public (login, register, webhooks)
- Use `secured: true` on GET routes that need protection (profile, admin pages)

## Auth Functions

```typescript
import { Auth, hashPassword, checkPassword } from "tina4-nodejs";

const auth = new Auth();                             // Uses SECRET from .env
const auth = new Auth({ secret: "custom-secret" });  // Or custom secret

const token = auth.createToken({ userId: 1 });       // Create JWT
const valid = auth.validateToken(token);              // Returns true/false
const payload = auth.getPayload(token);               // Returns object or null
const newToken = auth.refreshToken(token);            // Refresh before expiry

const hashed = hashPassword("my-password");           // PBKDF2-HMAC-SHA256
const valid = checkPassword(hashed, "my-password");   // Returns true/false
```
