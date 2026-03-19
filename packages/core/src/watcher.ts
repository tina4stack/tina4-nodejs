import { watch, existsSync } from "node:fs";
import { resolve } from "node:path";

export function watchForChanges(
  dirs: string[],
  onChange: () => void
): { close: () => void } {
  const watchers: ReturnType<typeof watch>[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const debouncedOnChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log("\n  \x1b[33mFile change detected, reloading routes...\x1b[0m\n");
      onChange();
    }, 200);
  };

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(resolve(dir), { recursive: true }, () => {
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
