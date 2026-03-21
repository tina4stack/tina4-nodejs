# Tina4 Example App

Minimal example demonstrating Tina4 Node.js conventions.

## Run

```bash
cd example
npx tsx app.ts
```

The server starts on http://localhost:7148.

## API

| Method | Path              | Description      |
|--------|-------------------|------------------|
| GET    | /                 | Welcome page     |
| GET    | /api/hello        | Hello world JSON |
| GET    | /api/users        | List all users   |
| POST   | /api/users        | Create a user    |
| GET    | /api/users/[id]   | Get user by ID   |
| GET    | /swagger          | Swagger UI       |

## Structure

```
app.ts                                  # Entry point
.env                                    # Environment config
src/models/User.ts                      # User model definition
src/routes/get.ts                       # GET /
src/routes/api/hello/get.ts             # GET /api/hello
src/routes/api/users/get.ts             # GET /api/users
src/routes/api/users/post.ts            # POST /api/users
src/routes/api/users/[id]/get.ts        # GET /api/users/:id
```

## Conventions

- **File-based routing** -- directory path maps to URL path
- **Dynamic params** -- `[id]` bracket notation becomes `request.params.id`
- **HTTP method** -- filename determines the method (`get.ts`, `post.ts`, etc.)
- **Response** -- callable `response(data, status)` or methods like `response.json()`, `response.html()`
- **Models** -- `static tableName` and `static fields` on a default-exported class
- **ESM only** -- `"type": "module"` everywhere, `.js` extensions in imports
