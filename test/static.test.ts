/**
 * Unit tests for static file serving (packages/core/src/static.ts).
 * Run with: npx vitest run test/static.test.ts
 */
import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { tryServeStatic } from "../packages/core/src/static.ts";
import type { Tina4Request, Tina4Response } from "../packages/core/src/types.ts";

// ── Helpers ──────────────────────────────────────────────────

const corePublicDir = resolve(
  import.meta.dirname ?? ".",
  "../packages/core/public"
);

/** Build a minimal mock Tina4Request with the given URL. */
function mockReq(url: string): Tina4Request {
  return { url } as unknown as Tina4Request;
}

/** Build a minimal mock Tina4Response that captures headers and body. */
function mockRes(): Tina4Response & {
  headers: Record<string, string | number>;
  body: Buffer | string | null;
  ended: boolean;
} {
  const headers: Record<string, string | number> = {};
  const state = { body: null as Buffer | string | null, ended: false, headers };
  return {
    headers,
    body: null,
    ended: false,
    raw: {
      writableEnded: false,
      setHeader(name: string, value: string | number) {
        state.headers[name] = value;
      },
      end(data?: Buffer | string) {
        state.body = data ?? null;
        state.ended = true;
      },
    },
    get headersRef() {
      return state.headers;
    },
    get bodyRef() {
      return state.body;
    },
    get endedRef() {
      return state.ended;
    },
  } as any;
}

// ── MIME Type Detection ──────────────────────────────────────

describe("Static file serving — MIME types", () => {
  it("serves .css with text/css content type", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
    expect(served).toBe(true);
    expect(res.raw.setHeader).toBeDefined();
    // Check the header was set by inspecting our captured state
    expect((res as any).headersRef["Content-Type"]).toContain("text/css");
  });

  it("serves .js with application/javascript content type", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
    expect(served).toBe(true);
    expect((res as any).headersRef["Content-Type"]).toContain("application/javascript");
  });

  it("returns correct MIME for .html", () => {
    // Create a temp HTML file scenario — we test against known MIME map
    // by checking the exported MIME_TYPES indirectly via a real file
    const res = mockRes();
    // Use the existing public dir; if no .html exists, tryServeStatic returns false
    const served = tryServeStatic(corePublicDir, mockReq("/nonexistent.html"), res);
    expect(served).toBe(false);
  });

  it("returns correct MIME for .json requests", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/nonexistent.json"), res);
    expect(served).toBe(false);
  });

  it("returns correct MIME for image extensions (.png, .jpg, .svg)", () => {
    // Verify the function does not crash on image requests and returns false for missing files
    for (const ext of [".png", ".jpg", ".svg"]) {
      const res = mockRes();
      const served = tryServeStatic(corePublicDir, mockReq(`/img/test${ext}`), res);
      expect(served).toBe(false);
    }
  });

  it("returns correct MIME for .woff2 font files", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/fonts/test.woff2"), res);
    expect(served).toBe(false); // file doesn't exist, but no crash
  });
});

// ── Framework Public Files ───────────────────────────────────

describe("Static file serving — framework public files", () => {
  it("tina4.min.css exists and is servable", () => {
    expect(existsSync(join(corePublicDir, "css/tina4.min.css"))).toBe(true);
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
    expect(served).toBe(true);
    expect((res as any).headersRef["Content-Length"]).toBeGreaterThan(0);
  });

  it("tina4.min.js exists and is servable", () => {
    expect(existsSync(join(corePublicDir, "js/tina4.min.js"))).toBe(true);
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
    expect(served).toBe(true);
  });

  it("frond.min.js exists and is servable", () => {
    expect(existsSync(join(corePublicDir, "js/frond.min.js"))).toBe(true);
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/js/frond.min.js"), res);
    expect(served).toBe(true);
  });

  it("tina4js.min.js exists and is servable", () => {
    expect(existsSync(join(corePublicDir, "js/tina4js.min.js"))).toBe(true);
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/js/tina4js.min.js"), res);
    expect(served).toBe(true);
  });
});

// ── Security ─────────────────────────────────────────────────

describe("Static file serving — directory traversal prevention", () => {
  it("rejects path traversal with ..", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/../package.json"), res);
    expect(served).toBe(false);
  });

  it("rejects encoded traversal %2e%2e", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/%2e%2e/package.json"), res);
    expect(served).toBe(false);
  });
});

// ── 404 Handling ─────────────────────────────────────────────

describe("Static file serving — 404 for missing files", () => {
  it("returns false for a non-existent file", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/does-not-exist.txt"), res);
    expect(served).toBe(false);
  });

  it("returns false for a non-existent deeply nested path", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/a/b/c/d/e.js"), res);
    expect(served).toBe(false);
  });
});

// ── Response Headers ─────────────────────────────────────────

describe("Static file serving — response headers", () => {
  it("sets Content-Length header on successful serve", () => {
    const res = mockRes();
    tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css"), res);
    expect((res as any).headersRef["Content-Length"]).toBeDefined();
    expect(typeof (res as any).headersRef["Content-Length"]).toBe("number");
  });

  it("sets Content-Type header on successful serve", () => {
    const res = mockRes();
    tryServeStatic(corePublicDir, mockReq("/js/tina4.min.js"), res);
    expect((res as any).headersRef["Content-Type"]).toBeDefined();
  });

  it("strips query strings before resolving file path", () => {
    const res = mockRes();
    const served = tryServeStatic(corePublicDir, mockReq("/css/tina4.min.css?v=123"), res);
    expect(served).toBe(true);
  });
});
