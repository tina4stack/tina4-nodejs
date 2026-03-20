# Hot Reload

In development mode (`tina4nodejs serve`), Tina4 watches your source files for changes and automatically reloads routes without restarting the server.

## How It Works

The dev server uses Node.js `fs.watch` with recursive watching on these directories:

- `src/routes/` -- route handler files
- `src/models/` -- model definitions
- `src/templates/` -- Twig templates

When any file changes, the route table is cleared and all routes are re-discovered from the file system. A 200ms debounce prevents multiple rapid reloads.

## Console Output

When a file change is detected:

```
  File change detected, reloading routes...
  Reloaded 5 route(s)
```

## What Gets Reloaded

- Route handlers are re-imported with cache-busting (`?t=timestamp` query parameter on the module URL).
- The route table is rebuilt from scratch, so renamed or deleted routes are handled correctly.

## Module Cache Busting

ESM modules are normally cached by Node.js. Tina4 appends a timestamp to the import URL to force a fresh import on each reload:

```typescript
// Internal mechanism
const moduleUrl = `file://${filePath}?t=${Date.now()}`;
const mod = await import(moduleUrl);
```

## Configuration

Hot reload is enabled automatically when using `tina4nodejs serve`. The `watchForChanges` function is available for custom use:

```typescript
import { watchForChanges } from "@tina4/core/src/watcher.js";

const watcher = watchForChanges(
  ["src/routes", "src/models"],
  () => {
    console.log("Files changed, reload logic here");
  }
);

// Clean up on shutdown
process.on("SIGINT", () => {
  watcher.close();
});
```

## Notes

- Hot reload re-discovers all routes, not just the changed file.
- Model changes (new fields, new models) are picked up on reload but database schema sync may require a restart.
- Template changes are picked up immediately since Twig re-reads files on each render.
- Hot reload is not intended for production -- use a build step instead.
