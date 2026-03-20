# Response API

The Tina4 response object is both callable and has methods. You can use it as a function for quick responses or call explicit methods for more control. It wraps Node.js `ServerResponse` with a fluent API.

## Callable Response

The response object itself is a function. Pass data and it auto-detects the content type.

```typescript
export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  // Object -> auto-JSON (application/json)
  res({ users: [], total: 0 });

  // Object with status code
  res({ error: "Not found" }, 404);

  // String starting with < -> auto-HTML (text/html)
  res("<h1>Hello World</h1>");

  // Other strings -> text/plain
  res("Just a plain message");

  // Explicit content type
  res(data, 200, "application/xml");

  // Buffer -> application/octet-stream
  res(Buffer.from("binary data"));

  // Null/undefined -> empty body
  res(null, 204);
}
```

## Explicit Methods

### JSON

```typescript
res.json({ users: [] });         // 200 with application/json
res.json({ id: 1 }, 201);        // 201 Created
```

### HTML

```typescript
res.html("<h1>Hello</h1>");      // 200 with text/html
res.html("<p>Error</p>", 500);   // 500 with text/html
```

### Plain Text

```typescript
res.text("OK");                  // 200 with text/plain
res.text("Not found", 404);     // 404 with text/plain
```

### Status + Chain

```typescript
res.status(201).json({ created: true });
res.status(404).json({ error: "Not found" });
```

### Headers

```typescript
res.header("X-Custom", "value").json({ data: [] });
res.header("Content-Type", "text/csv").send(csvData);
```

### Redirect

```typescript
res.redirect("/login");           // 302 redirect
res.redirect("/new-url", 301);    // 301 permanent redirect
```

### Send (Generic)

```typescript
// Same as calling res() directly
res.send({ data: [] });
res.send("text", 200, "text/plain");
```

## Cookies

### Set a Cookie

```typescript
res.cookie("session_id", "abc123", {
  httpOnly: true,
  secure: true,
  path: "/",
  maxAge: 3600,           // Seconds
  sameSite: "Lax",        // "Strict" | "Lax" | "None"
});
```

### Cookie Options

```typescript
interface CookieOptions {
  maxAge?: number;          // Lifetime in seconds
  expires?: Date;           // Expiry date
  path?: string;            // URL path scope
  domain?: string;          // Domain scope
  secure?: boolean;         // HTTPS only
  httpOnly?: boolean;       // No JavaScript access
  sameSite?: "Strict" | "Lax" | "None";
}
```

### Clear a Cookie

```typescript
res.clearCookie("session_id", { path: "/" });
```

Multiple `Set-Cookie` headers are handled correctly -- calling `res.cookie()` multiple times appends to the header array.

## Raw ServerResponse

For advanced use cases, access the underlying `ServerResponse`:

```typescript
res.raw.writeHead(200, { "Content-Type": "text/event-stream" });
res.raw.write("data: hello\n\n");
// ...
res.raw.end();
```

## Fluent Chaining

Most methods return the response object for chaining:

```typescript
res
  .status(200)
  .header("X-Request-Id", "abc123")
  .cookie("visited", "true", { maxAge: 86400 })
  .json({ message: "OK" });
```

## Content Type Auto-Detection

When using the callable form `res(data)`:

| Data Type | Detected Content-Type |
|-----------|----------------------|
| Object / Array | `application/json` |
| String starting with `<` and ending with `>` | `text/html; charset=utf-8` |
| Other strings | `text/plain; charset=utf-8` |
| Buffer | `application/octet-stream` |
| null / undefined | Empty body |
