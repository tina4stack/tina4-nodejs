# Environment Configuration

Tina4 loads environment variables from a `.env` file on server startup. The built-in parser handles quoted values, comments, multi-line values, and the `export` prefix. Zero dependencies -- no `dotenv` package needed.

## .env File Format

```bash
# .env
PORT=3000
DATABASE_URL=sqlite:///data/app.db

# Quoted values (escape sequences processed in double quotes)
APP_NAME="My Tina4 App"
SECRET_KEY='no-escapes-here'
GREETING="Hello\nWorld"

# export prefix is stripped
export NODE_ENV=development

# Multi-line with backslash continuation
LONG_VALUE=this is a \
  very long value

# Inline comments (unquoted values only)
CACHE_TTL=300  # 5 minutes
```

## Loading

The `.env` file is loaded automatically when the server starts. You can also load it manually:

```typescript
import { loadEnv } from "@tina4/core";

// Load from default .env in current directory
const vars = loadEnv();

// Load from a specific path
const vars = loadEnv(".env.production");
```

**Important:** `loadEnv()` does not override existing `process.env` values. If an environment variable is already set (e.g., from the shell), the `.env` value is ignored.

## Reading Environment Variables

```typescript
import { getEnv, requireEnv } from "@tina4/core";

// Get with optional default
const port = getEnv("PORT", "3000");           // "3000" if not set
const dbUrl = getEnv("DATABASE_URL");           // undefined if not set

// Get required (throws if not set)
const secret = requireEnv("JWT_SECRET");
// Error: Required environment variable "JWT_SECRET" is not set.
```

## Tina4 Environment Variables

These are read by Tina4 internals:

| Variable | Used By | Default |
|----------|---------|---------|
| `DATABASE_URL` | Database initialization | -- |
| `TINA4_CORS_ORIGINS` | CORS middleware | `*` |
| `TINA4_CORS_METHODS` | CORS middleware | `GET, POST, PUT, DELETE, PATCH, OPTIONS` |
| `TINA4_CORS_HEADERS` | CORS middleware | `Content-Type, Authorization` |
| `TINA4_CORS_MAX_AGE` | CORS middleware | `86400` |
| `TINA4_RATE_LIMIT` | Rate limiter | `100` |
| `TINA4_RATE_WINDOW` | Rate limiter | `60` |
| `TINA4_CACHE_TTL` | Response cache | `60` |
| `TINA4_SESSION_BACKEND` | Sessions | `file` |
| `TINA4_SESSION_PATH` | Sessions | `data/sessions` |
| `TINA4_SESSION_TTL` | Sessions | `3600` |
| `TINA4_QUEUE_BACKEND` | Queue | `file` |
| `TINA4_QUEUE_PATH` | Queue | `data/queue` |
| `TINA4_LOCALE_DIR` | i18n | `src/locales` |
| `TINA4_LOCALE` | i18n | `en` |
| `TINA4_ENV` | Logger (production mode) | -- |
| `NODE_ENV` | Logger (production mode) | -- |

## Supported Syntax

| Syntax | Example | Notes |
|--------|---------|-------|
| Simple | `KEY=value` | Basic assignment |
| Double quoted | `KEY="value"` | Processes `\n`, `\r`, `\t`, `\"`, `\\` |
| Single quoted | `KEY='value'` | Literal, no escape processing |
| Export prefix | `export KEY=value` | `export` is stripped |
| Comments | `# This is a comment` | Full-line comments |
| Inline comments | `KEY=value  # comment` | Only for unquoted values |
| Multi-line | `KEY=line1 \` (newline) `line2` | Backslash continuation |
| Empty lines | | Ignored |

## Notes

- The parser is a built-in zero-dependency implementation.
- File is resolved relative to the current working directory.
- If `.env` does not exist, `loadEnv()` returns an empty object silently.
- Variable interpolation (e.g., `$OTHER_VAR`) is not supported -- use explicit values.
