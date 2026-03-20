# Logging

Tina4 provides a structured `Log` class with file rotation, JSON output in production, and colorized console output in development. Zero dependencies.

## Basic Usage

```typescript
import { Log } from "@tina4/core";

Log.info("Server started on port 3000");
Log.debug("Processing request", { method: "GET", url: "/api/users" });
Log.warning("Deprecated endpoint accessed", { endpoint: "/api/v1/users" });
Log.error("Database connection failed", { error: "ECONNREFUSED" });
```

## Log Levels

| Level | Method | Terminal Color | Use Case |
|-------|--------|---------------|----------|
| `DEBUG` | `Log.debug()` | Gray | Detailed debugging information |
| `INFO` | `Log.info()` | Cyan | General operational messages |
| `WARNING` | `Log.warning()` | Yellow | Potential issues or deprecations |
| `ERROR` | `Log.error()` | Red | Errors that need attention |

## Development Output

In development mode, logs are colorized and human-readable:

```
[INFO] 2024-03-15T10:30:00.000Z Server started on port 3000
[DEBUG] 2024-03-15T10:30:01.123Z [req-abc123] Processing request {"method":"GET","url":"/api/users"}
[WARNING] 2024-03-15T10:31:00.000Z Deprecated endpoint accessed {"endpoint":"/api/v1/users"}
[ERROR] 2024-03-15T10:32:00.000Z Database connection failed {"error":"ECONNREFUSED"}
```

## Production Output

When `TINA4_ENV=production` or `NODE_ENV=production`, logs are written as JSON lines to `logs/tina4.log` only (no console output):

```json
{"timestamp":"2024-03-15T10:30:00.000Z","level":"INFO","message":"Server started on port 3000"}
{"timestamp":"2024-03-15T10:30:01.123Z","level":"DEBUG","message":"Processing request","requestId":"req-abc123","data":{"method":"GET","url":"/api/users"}}
```

## Request Correlation

Attach a request ID for log correlation across a request lifecycle:

```typescript
import { Log } from "@tina4/core";

// In middleware or at request start
Log.setRequestId("req-abc123");

Log.info("Processing request");  // Includes requestId in output
Log.info("Query executed");       // Same requestId

// Clear at end of request
Log.setRequestId(undefined);
```

## Configuration

```typescript
import { Log } from "@tina4/core";

Log.configure({
  logDir: "logs",          // Directory for log files (default: "logs")
  logFile: "app.log",      // Log filename (default: "tina4.log")
});
```

## File Rotation

Log files are automatically rotated when they exceed 10MB. Rotated files are named with the date and a counter:

```
logs/
  tina4.log                    # Current log file
  tina4-2024-03-14-1.log      # Rotated file
  tina4-2024-03-14-2.log      # Second rotation on same day
```

## Log Entry Structure

```typescript
interface LogEntry {
  timestamp: string;      // ISO 8601
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR";
  message: string;
  requestId?: string;     // If set via Log.setRequestId()
  data?: unknown;         // Optional structured data
}
```

## Notes

- In development, logs are written to both console and file.
- In production, logs are written to file only (JSON lines format).
- The `logs/` directory is created automatically if it doesn't exist.
- Logging never throws -- if file writing fails, the error is silently swallowed.
- The log rotation check happens on every write, keeping the implementation simple.
