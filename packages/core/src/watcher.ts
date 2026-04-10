import { watch, existsSync } from "node:fs";
import { resolve, extname } from "node:path";

/**
 * File types that indicate a code change and require route re-discovery.
 * Template/CSS/JS asset changes don't need the router to be touched.
 */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

// Module-level state for start()/stop() API
let _watchers: ReturnType<typeof watch>[] = [];
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _codeChangePending = false;
let _running = false;

/**
 * Start the DevReload file watcher.
 *
 * Watches the given directories for file changes and calls onChange when
 * a change is detected. Mirrors the Python DevReload.start() API.
 *
 * @param dirs - Directories to watch. Defaults to ["src", "public"].
 * @param onChange - Callback invoked on file change. Receives `{ code: boolean }`.
 */
export function start(
  dirs: string[] = ["src", "public"],
  onChange: (info: { code: boolean }) => void = () => {},
): void {
  if (_running) return;
  _running = true;

  const debouncedOnChange = () => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      const code = _codeChangePending;
      _codeChangePending = false;
      console.log(
        `\n  \x1b[33mFile change detected${code ? ", reloading routes" : ""}...\x1b[0m\n`,
      );
      onChange({ code });
    }, 200);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(resolve(dir), { recursive: true }, (_event, filename) => {
        if (filename && CODE_EXTENSIONS.has(extname(filename))) {
          _codeChangePending = true;
        }
        debouncedOnChange();
      });
      _watchers.push(watcher);
    } catch {
      console.warn(`  Warning: Could not watch ${dir}`);
    }
  }
}

/**
 * Stop the DevReload file watcher.
 *
 * Closes all active file watchers and resets internal state.
 * Mirrors the Python DevReload.stop() API.
 */
export function stop(): void {
  if (!_running) return;
  _running = false;
  for (const w of _watchers) w.close();
  _watchers = [];
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = null;
  _codeChangePending = false;
}

/**
 * Watch directories for file changes.
 *
 * The callback receives `{ code: boolean }` indicating whether any of the
 * changed files were source code (.ts/.js). If only templates/CSS/JS assets
 * changed, `code` is false and the caller should skip route re-discovery —
 * clearing the router for an asset edit leaves a brief window of 404s that
 * make the dev toolbar vanish.
 */
export function watchForChanges(
  dirs: string[],
  onChange: (info: { code: boolean }) => void
): { close: () => void } {
  const watchers: ReturnType<typeof watch>[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let codeChangePending = false;

  const debouncedOnChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const code = codeChangePending;
      codeChangePending = false;
      console.log(
        `\n  \x1b[33mFile change detected${code ? ", reloading routes" : ""}...\x1b[0m\n`,
      );
      onChange({ code });
    }, 200);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(resolve(dir), { recursive: true }, (_event, filename) => {
        if (filename && CODE_EXTENSIONS.has(extname(filename))) {
          codeChangePending = true;
        }
        debouncedOnChange();
      });
      watchers.push(watcher);
    } catch {
      console.warn(`  Warning: Could not watch ${dir}`);
    }
  }

  return {
    close: () => {
      for (const w of watchers) w.close();
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}
