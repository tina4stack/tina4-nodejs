# Request API

The Tina4 request object extends Node.js `IncomingMessage` with parsed body, query parameters, route parameters, file uploads, and client IP detection.

## Request Properties

```typescript
interface Tina4Request extends IncomingMessage {
  params: Record<string, string>;     // Route parameters ({id}, [id], :id)
  query: Record<string, string>;      // URL query string parameters
  body: unknown;                       // Parsed request body
  ip: string;                          // Client IP address
  files: UploadedFile[];              // Uploaded files (multipart)
  // Plus all standard IncomingMessage properties:
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}
```

## Route Parameters

Extracted from dynamic URL segments:

```typescript
// Route: /api/users/{id}/posts/{postId}
// URL:   /api/users/42/posts/7

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  req.params.id;      // "42"
  req.params.postId;  // "7"
}
```

## Query String

Parsed from the URL after `?`:

```typescript
// URL: /api/users?name=Alice&active=true

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  req.query.name;    // "Alice"
  req.query.active;  // "true"
}
```

## Body Parsing

The request body is automatically parsed based on `Content-Type`:

### JSON Body

```bash
curl -X POST http://localhost:7148/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice", "email": "alice@test.com"}'
```

```typescript
const body = req.body as { name: string; email: string };
body.name;   // "Alice"
body.email;  // "alice@test.com"
```

### Form URL-Encoded Body

```bash
curl -X POST http://localhost:7148/api/login \
  -d "username=alice&password=secret"
```

```typescript
const body = req.body as Record<string, string>;
body.username;  // "alice"
body.password;  // "secret"
```

### Multipart Form Data (File Uploads)

```bash
curl -X POST http://localhost:7148/api/upload \
  -F "avatar=@photo.jpg" \
  -F "name=Alice"
```

```typescript
export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  // Regular form fields are in req.body
  const body = req.body as Record<string, string>;
  body.name;  // "Alice"

  // Files are in req.files
  for (const file of req.files) {
    console.log(file.fieldName);    // "avatar"
    console.log(file.filename);     // "photo.jpg"
    console.log(file.contentType);  // "image/jpeg"
    console.log(file.size);         // 102400 (bytes)
    // file.data is a Buffer containing the file contents
  }

  res.json({ uploaded: req.files.length });
}
```

### UploadedFile Interface

```typescript
interface UploadedFile {
  fieldName: string;     // Form field name
  filename: string;      // Original file name
  contentType: string;   // MIME type
  data: Buffer;          // File contents
  size: number;          // Size in bytes
}
```

### Raw Text Body

For other content types, the body is available as a raw string.

## IP Detection

The client IP is determined with proxy support:

1. `X-Forwarded-For` header (first IP) -- for reverse proxy setups
2. `req.socket.remoteAddress` -- direct connections
3. `"127.0.0.1"` -- fallback

```typescript
export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  console.log("Client IP:", req.ip);
  res.json({ ip: req.ip });
}
```

## Standard Properties

All standard `IncomingMessage` properties are available:

```typescript
req.method;                    // "GET", "POST", etc.
req.url;                       // "/api/users?page=2"
req.headers["content-type"];   // "application/json"
req.headers.authorization;     // "Bearer eyJ..."
req.headers["user-agent"];     // "curl/7.88.1"
```

## Notes

- Body parsing is skipped for GET, HEAD, and OPTIONS requests.
- The multipart parser is a zero-dependency implementation built into Tina4.
- If JSON body parsing fails (invalid JSON), the raw string is stored in `req.body`.
- Query parameters are parsed using the WHATWG `URL` constructor.
