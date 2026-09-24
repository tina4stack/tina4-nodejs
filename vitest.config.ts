import { defineConfig } from "vitest/config";

// A test run must never open the developer's browser. `startServer()` opens a
// tab after listen unless TINA4_NO_BROWSER is set. test/run-all.ts sets it for
// every tsx child; this is the same default for suites run straight through
// vitest (`npm run test:i18n`), so a vitest suite that spawns a server cannot
// open one either. A test that checks the browser path overrides it locally.
export default defineConfig({
  test: {
    env: { TINA4_NO_BROWSER: "true" },
  },
});
