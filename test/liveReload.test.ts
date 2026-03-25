/**
 * Unit tests for the file watcher / live reload (packages/core/src/watcher.ts).
 * Run with: npx vitest run test/liveReload.test.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchForChanges } from "../packages/core/src/watcher.ts";

// ── Helpers ──────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tina4-watcher-test-"));
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
  cleanups.length = 0;
});

// ── Existence & Shape ────────────────────────────────────────

describe("Watcher — exports and shape", () => {
  it("watchForChanges is a function", () => {
    expect(typeof watchForChanges).toBe("function");
  });

  it("returns an object with a close method", () => {
    const dir = makeTempDir();
    const watcher = watchForChanges([dir], () => {});
    cleanups.push(() => {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    });
    expect(watcher).toBeDefined();
    expect(typeof watcher.close).toBe("function");
  });

  it("accepts an array of directories", () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();
    const watcher = watchForChanges([dir1, dir2], () => {});
    cleanups.push(() => {
      watcher.close();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    });
    expect(watcher).toBeDefined();
  });

  it("handles non-existent directories gracefully", () => {
    const watcher = watchForChanges(["/tmp/does-not-exist-tina4-test"], () => {});
    cleanups.push(() => watcher.close());
    expect(watcher).toBeDefined();
  });
});

// ── File Change Detection ────────────────────────────────────

describe("Watcher — file change detection", () => {
  it("triggers callback when a file is created", async () => {
    const dir = makeTempDir();
    let called = false;
    const watcher = watchForChanges([dir], () => {
      called = true;
    });
    cleanups.push(() => {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // Write a file to trigger the watcher
    writeFileSync(join(dir, "test.ts"), "export default 1;");

    // Wait for debounce (watcher uses 200ms debounce)
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(called).toBe(true);
  });

  it("triggers callback when a file is modified", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "existing.ts");
    writeFileSync(filePath, "const a = 1;");

    // Small delay to ensure the watcher starts after file creation
    await new Promise((resolve) => setTimeout(resolve, 100));

    let callCount = 0;
    const watcher = watchForChanges([dir], () => {
      callCount++;
    });
    cleanups.push(() => {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // Modify the file
    writeFileSync(filePath, "const a = 2;");

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it("debounces rapid changes into a single callback", async () => {
    const dir = makeTempDir();
    let callCount = 0;
    const watcher = watchForChanges([dir], () => {
      callCount++;
    });
    cleanups.push(() => {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    });

    // Write multiple files rapidly (within debounce window of 200ms)
    writeFileSync(join(dir, "a.ts"), "1");
    writeFileSync(join(dir, "b.ts"), "2");
    writeFileSync(join(dir, "c.ts"), "3");

    await new Promise((resolve) => setTimeout(resolve, 400));
    // Should have been debounced — callCount should be small (1-2, not 3)
    expect(callCount).toBeLessThanOrEqual(2);
  });

  it("watches subdirectories recursively", async () => {
    const dir = makeTempDir();
    const subDir = join(dir, "sub");
    mkdirSync(subDir, { recursive: true });

    let called = false;
    const watcher = watchForChanges([dir], () => {
      called = true;
    });
    cleanups.push(() => {
      watcher.close();
      rmSync(dir, { recursive: true, force: true });
    });

    writeFileSync(join(subDir, "nested.ts"), "nested");

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(called).toBe(true);
  });
});

// ── Cleanup ──────────────────────────────────────────────────

describe("Watcher — cleanup", () => {
  it("close() stops the watcher without errors", () => {
    const dir = makeTempDir();
    const watcher = watchForChanges([dir], () => {});
    expect(() => watcher.close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("close() can be called multiple times safely", () => {
    const dir = makeTempDir();
    const watcher = watchForChanges([dir], () => {});
    watcher.close();
    expect(() => watcher.close()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not trigger callback after close()", async () => {
    const dir = makeTempDir();
    let called = false;
    const watcher = watchForChanges([dir], () => {
      called = true;
    });
    watcher.close();

    writeFileSync(join(dir, "after-close.ts"), "should not trigger");
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(called).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
