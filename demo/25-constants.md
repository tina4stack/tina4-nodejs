# Constants

Tina4 exports standard HTTP status codes and content type constants for use in route handlers. These provide readable, consistent values across your codebase.

## HTTP Status Codes

```typescript
import {
  HTTP_OK,              // 200
  HTTP_CREATED,         // 201
  HTTP_ACCEPTED,        // 202
  HTTP_NO_CONTENT,      // 204
  HTTP_MOVED,           // 301
  HTTP_REDIRECT,        // 302
  HTTP_NOT_MODIFIED,    // 304
  HTTP_BAD_REQUEST,     // 400
  HTTP_UNAUTHORIZED,    // 401
  HTTP_FORBIDDEN,       // 403
  HTTP_NOT_FOUND,       // 404
  HTTP_METHOD_NOT_ALLOWED, // 405
  HTTP_CONFLICT,        // 409
  HTTP_GONE,            // 410
  HTTP_UNPROCESSABLE,   // 422
  HTTP_TOO_MANY,        // 429
  HTTP_SERVER_ERROR,    // 500
  HTTP_BAD_GATEWAY,     // 502
  HTTP_UNAVAILABLE,     // 503
} from "@tina4/core";
```

## Content Types

```typescript
import {
  APPLICATION_JSON,     // "application/json"
  APPLICATION_XML,      // "application/xml"
  APPLICATION_FORM,     // "application/x-www-form-urlencoded"
  APPLICATION_OCTET,    // "application/octet-stream"
  TEXT_HTML,            // "text/html; charset=utf-8"
  TEXT_PLAIN,           // "text/plain; charset=utf-8"
  TEXT_CSV,             // "text/csv"
  TEXT_XML,             // "text/xml"
} from "@tina4/core";
```

## Usage in Route Handlers

```typescript
import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK, HTTP_CREATED, HTTP_NOT_FOUND, APPLICATION_JSON } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const userId = req.params.id;
  const user = findUser(userId);

  if (!user) {
    res({ error: "User not found" }, HTTP_NOT_FOUND);
    return;
  }

  res(user, HTTP_OK, APPLICATION_JSON);
}
```

### With Response Methods

```typescript
import { HTTP_CREATED, HTTP_UNPROCESSABLE } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const body = req.body as Record<string, unknown>;

  if (!body.name) {
    res.status(HTTP_UNPROCESSABLE).json({ error: "Name is required" });
    return;
  }

  const created = saveUser(body);
  res.json(created, HTTP_CREATED);
}
```

## Notes

- These constants match the values used by Tina4 across all four framework implementations (Python, PHP, Go, Node.js).
- Using constants instead of magic numbers improves readability and prevents typos.
- The full set of 2xx, 3xx, 4xx, and 5xx codes covers the most common HTTP scenarios.
