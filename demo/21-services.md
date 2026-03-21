# Background Services

Tina4 provides a `ServiceRunner` for in-process background services using Node.js timers. Services can run on cron schedules, simple intervals, or in continuous daemon mode. Zero dependencies.

## Registering a Service

```typescript
import { ServiceRunner } from "tina4-nodejs";

// Run every 5 minutes (cron syntax)
ServiceRunner.register("cleanup", async (context) => {
  console.log(`Running cleanup at ${new Date().toISOString()}`);
  // Clean up expired sessions, temp files, etc.
}, { timing: "*/5 * * * *" });

// Run every 30 seconds (simple interval)
ServiceRunner.register("health-ping", async (context) => {
  console.log("Pinging health endpoint...");
}, { interval: 30 });

// Continuous daemon mode
ServiceRunner.register("queue-worker", async (context) => {
  while (context.running) {
    // Process queue items
    await processNextJob();
    await sleep(1000);
  }
}, { daemon: true });

// Start all registered services
ServiceRunner.startAll();
```

## ServiceOptions

```typescript
interface ServiceOptions {
  timing?: string;       // Cron expression: "*/5 * * * *"
  daemon?: boolean;      // Continuous execution mode
  interval?: number;     // Simple interval in seconds
  maxRetries?: number;   // Restart on crash (default: 3)
}
```

## Cron Syntax

Standard 5-field cron expressions:

```
 minute  hour  dayOfMonth  month  dayOfWeek
   *       *       *         *       *
```

| Expression | Schedule |
|-----------|----------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 0 1 * *` | First day of every month |
| `30 8 * * 1` | Every Monday at 8:30 AM |

### Supported cron features:

- `*` -- every value
- `N` -- exact value
- `N/step` or `*/step` -- step values
- `N,N,N` -- lists
- `N-N` -- ranges

## ServiceContext

The handler receives a context object:

```typescript
interface ServiceContext {
  running: boolean;     // Set to false to stop daemon services
  lastRun: Date | null; // Timestamp of last execution
  name: string;         // Service name
}
```

## Managing Services

```typescript
import { ServiceRunner } from "tina4-nodejs";

// Start all services
ServiceRunner.startAll();

// Stop a specific service
ServiceRunner.stop("cleanup");

// Stop all services
ServiceRunner.stopAll();

// List all services
const services = ServiceRunner.list();
// [{ name: "cleanup", options: {...}, running: true, lastRun: Date, retries: 0 }]
```

## Auto-Discovery

The `ServiceRunner` can discover service files from a directory:

```typescript
// Place service files in src/services/
// Each file exports a handler and options

// src/services/cleanup.ts
export const options = { timing: "0 * * * *" };
export default async function (context) {
  // Hourly cleanup logic
}
```

```typescript
// Start with auto-discovery
await ServiceRunner.discover("src/services");
ServiceRunner.startAll();
```

## Error Handling

Services automatically restart on crash up to `maxRetries` times (default: 3).

```typescript
ServiceRunner.register("risky-service", async (context) => {
  // If this throws, it will be restarted up to 3 times
  await riskyOperation();
}, { interval: 60, maxRetries: 5 });
```

## Notes

- Services run in-process using `setInterval` timers.
- Timers are unreffed so they don't prevent process exit.
- Cron matching is evaluated every minute against the current time.
- Daemon services run continuously in an async loop.
