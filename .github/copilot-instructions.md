# tina4-nodejs Copilot Instructions

Tina4 Node.js/TypeScript v3. 140 cataloged features, zero dependencies. ESM only.

## Route Pattern

```typescript
// File-based: src/routes/api/users/get.ts → GET /api/users
export default async function (req: Tina4Request, res: Tina4Response) {
  return res.json({ users: [] });
}

// Explicit: Router.get("/api/users", async (req, res) => res.json({ users: [] }));
```

## Critical Rules

- ESM only — .js extensions in imports for .ts files
- No Express/Fastify — native node:http
- No decorators — convention-based models (static tableName, static fields)
- Auth: `/** @noauth */` JSDoc for public POST/PUT/DELETE
- Auth: `/** @secure */` JSDoc for protected GET
- Queue: `job.payload` not `job.data`
- Import from "@tina4/core", "@tina4/orm" — not internal paths
- Route params: `{id}` in URLs, `[id]` in directory names

See llms.txt for full API reference.
