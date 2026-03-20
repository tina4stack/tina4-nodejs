# Static Files

Tina4 serves static files from the `public/` directory. Any file placed there is accessible directly by its path, with automatic MIME type detection and `index.html` fallback for directories.

## Setup

Place files in the `public/` directory at your project root. No configuration needed.

```
public/
  index.html
  css/
    style.css
  js/
    app.js
  images/
    logo.png
  favicon.ico
```

These are served as:

| File | URL |
|------|-----|
| `public/index.html` | `http://localhost:3000/` or `http://localhost:3000/index.html` |
| `public/css/style.css` | `http://localhost:3000/css/style.css` |
| `public/js/app.js` | `http://localhost:3000/js/app.js` |
| `public/images/logo.png` | `http://localhost:3000/images/logo.png` |
| `public/favicon.ico` | `http://localhost:3000/favicon.ico` |

## MIME Type Detection

Tina4 detects content types by file extension:

| Extension | Content-Type |
|-----------|-------------|
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js` | `application/javascript; charset=utf-8` |
| `.json` | `application/json; charset=utf-8` |
| `.png` | `image/png` |
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.svg` | `image/svg+xml` |
| `.ico` | `image/x-icon` |
| `.woff` | `font/woff` |
| `.woff2` | `font/woff2` |
| `.ttf` | `font/ttf` |
| `.txt` | `text/plain; charset=utf-8` |
| `.xml` | `application/xml` |
| `.pdf` | `application/pdf` |

Unknown extensions default to `application/octet-stream`.

## Directory Index

Requesting a directory path serves the `index.html` file within it:

- `GET /` serves `public/index.html`
- `GET /docs/` serves `public/docs/index.html`

## Request Priority

Static files are checked **before** route matching. If a file exists at the requested path in `public/`, it is served directly. Routes only match if no static file is found.

## Security

Directory traversal is prevented. Requests that attempt to escape the `public/` directory (e.g., `/../etc/passwd`) are blocked.

## Custom Static Directory

Override the default `public/` directory when starting the server:

```typescript
import { startServer } from "@tina4/core";

await startServer({
  port: 3000,
  staticDir: "assets",  // Serve from "assets/" instead of "public/"
});
```

## Response Headers

Static file responses include:
- `Content-Type` based on file extension
- `Content-Length` set to the file size in bytes
