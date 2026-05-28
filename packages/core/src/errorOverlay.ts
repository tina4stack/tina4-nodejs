/**
 * Tina4 Debug — Rich error overlay for development mode.
 *
 * Renders a professional, syntax-highlighted HTML error page when an unhandled
 * exception occurs in a route handler.
 *
 *   import { renderErrorOverlay, renderProductionError, isDebugMode } from "./errorOverlay.js";
 *
 *   try {
 *     await handler(req, res);
 *   } catch (err) {
 *     const html = isDebugMode()
 *       ? renderErrorOverlay(err as Error, req)
 *       : renderProductionError();
 *     res.html(html, 500);
 *   }
 *
 * Only activate when TINA4_DEBUG is true.
 * In production, call renderProductionError() instead.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isTruthy } from "./dotenv.js";

// ── Colour palette (Catppuccin Mocha) ────────────────────────────────────
const BG = "#1e1e2e";
const SURFACE = "#313244";
const OVERLAY = "#45475a";
const TEXT = "#cdd6f4";
const SUBTEXT = "#a6adc8";
const RED = "#f38ba8";
const YELLOW = "#f9e2af";
const BLUE = "#89b4fa";
const GREEN = "#a6e3a1";
const LAVENDER = "#b4befe";
const PEACH = "#fab387";
const ERROR_LINE_BG = "rgba(243,139,168,0.15)";

const CONTEXT_LINES = 7;

interface StackFrame {
  file: string;
  line: number;
  column: number;
  func: string;
}

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const lines = stack.split("\n");
  for (const line of lines) {
    // Match: "    at functionName (file:line:col)"
    let match = line.match(/^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (match) {
      frames.push({ func: match[1], file: match[2], line: parseInt(match[3], 10), column: parseInt(match[4], 10) });
      continue;
    }
    // Match: "    at file:line:col"
    match = line.match(/^\s*at\s+(.+?):(\d+):(\d+)/);
    if (match) {
      frames.push({ func: "{anonymous}", file: match[1], line: parseInt(match[2], 10), column: parseInt(match[3], 10) });
    }
  }
  return frames;
}

function readSourceLines(filename: string, lineno: number): Array<[number, string, boolean]> {
  try {
    const absPath = resolve(filename);
    const content = readFileSync(absPath, "utf-8");
    const allLines = content.split("\n");
    const start = Math.max(0, lineno - CONTEXT_LINES - 1);
    const end = Math.min(allLines.length, lineno + CONTEXT_LINES);
    const result: Array<[number, string, boolean]> = [];
    for (let i = start; i < end; i++) {
      const num = i + 1;
      result.push([num, allLines[i] ?? "", num === lineno]);
    }
    return result;
  } catch {
    return [];
  }
}

function formatSourceBlock(filename: string, lineno: number): string {
  const lines = readSourceLines(filename, lineno);
  if (lines.length === 0) return "";

  const rows = lines.map(([num, text, isError]) => {
    const bg = isError ? `background:${ERROR_LINE_BG};` : "";
    const marker = isError ? "&#x25b6;" : " ";
    return `<div style="${bg}display:flex;padding:1px 0;">`
      + `<span style="color:${YELLOW};min-width:3.5em;text-align:right;padding-right:1em;user-select:none;">${num}</span>`
      + `<span style="color:${RED};width:1.2em;user-select:none;">${marker}</span>`
      + `<span style="color:${TEXT};white-space:pre-wrap;tab-size:4;">${esc(text)}</span>`
      + `</div>`;
  }).join("\n");

  return `<div style="background:${SURFACE};border-radius:6px;padding:12px;overflow-x:auto;`
    + `font-family:'SF Mono','Fira Code','Consolas',monospace;font-size:13px;line-height:1.6;">`
    + rows + `</div>`;
}

/**
 * Render one stack frame.
 *
 * When the file was modified AFTER `capturedAt`, append a peach
 * "FILE MODIFIED" badge so a stale browser-cached overlay can't lie
 * about what the source looks like now. The AI coder often rewrites
 * files in place between page loads, leaving the overlay's source
 * view showing different code than what raised the error.
 *
 * `capturedAt` is in seconds (Date.now() / 1000) for parity with
 * Python's time.time().
 */
function formatFrame(frame: StackFrame, capturedAt = 0): string {
  const source = frame.file && frame.line > 0 ? formatSourceBlock(frame.file, frame.line) : "";
  let staleBadge = "";
  if (capturedAt && frame.file) {
    try {
      const absPath = resolve(frame.file);
      const mtime = statSync(absPath).mtimeMs / 1000;
      if (mtime > capturedAt + 0.5) {  // 0.5s margin for fs noise
        const d = new Date(mtime * 1000);
        const mtimeIso = `${String(d.getUTCHours()).padStart(2, "0")}:`
          + `${String(d.getUTCMinutes()).padStart(2, "0")}:`
          + `${String(d.getUTCSeconds()).padStart(2, "0")}`;
        staleBadge = ` <span style="background:${PEACH};color:${BG};padding:1px 8px;`
          + `border-radius:3px;font-size:11px;font-weight:700;margin-left:6px;">`
          + `FILE MODIFIED @ ${mtimeIso} UTC &mdash; source may not match what failed</span>`;
      }
    } catch {
      // best-effort — ignore missing files / permission errors
    }
  }
  return `<div style="margin-bottom:16px;">`
    + `<div style="margin-bottom:4px;">`
    + `<span style="color:${BLUE};">${esc(frame.file)}</span>`
    + `<span style="color:${SUBTEXT};"> : </span>`
    + `<span style="color:${YELLOW};">${frame.line}</span>`
    + `<span style="color:${SUBTEXT};"> in </span>`
    + `<span style="color:${GREEN};">${esc(frame.func)}</span>`
    + staleBadge
    + `</div>`
    + source
    + `</div>`;
}

function collapsible(title: string, content: string, openByDefault = false): string {
  const open = openByDefault ? " open" : "";
  return `<details style="margin-top:16px;"${open}>`
    + `<summary style="cursor:pointer;color:${LAVENDER};font-weight:600;font-size:15px;`
    + `padding:8px 0;user-select:none;">${esc(title)}</summary>`
    + `<div style="padding:8px 0;">${content}</div>`
    + `</details>`;
}

function table(pairs: Array<[string, string]>): string {
  if (pairs.length === 0) return `<span style="color:${SUBTEXT};">None</span>`;
  const rows = pairs.map(([key, val]) =>
    `<tr>`
    + `<td style="color:${PEACH};padding:4px 16px 4px 0;vertical-align:top;white-space:nowrap;">${esc(key)}</td>`
    + `<td style="color:${TEXT};padding:4px 0;word-break:break-all;">${esc(val)}</td>`
    + `</tr>`
  ).join("");
  return `<table style="border-collapse:collapse;width:100%;">${rows}</table>`;
}

/**
 * Render a rich HTML error overlay.
 *
 * @param error - The caught error.
 * @param request - Optional request object with method, url, headers, etc.
 * @returns Complete HTML page string.
 */
export function renderErrorOverlay(error: Error, request?: any): string {
  // Stamp ONCE per render — every frame compares against this. Seconds-since-epoch
  // matches Python's time.time() so frames stale by < 0.5s of fs noise don't trip.
  const capturedAt = Date.now() / 1000;
  const excType = error.constructor?.name ?? "Error";
  const excMsg = error.message ?? String(error);
  const frames = error.stack ? parseStack(error.stack) : [];

  // ── Stack trace ──
  // Each frame compares its source file's mtime to capturedAt and flags itself
  // if the file has been modified since — protects against the "browser cached
  // an old overlay, then the AI rewrote the file" confusion where displayed
  // source no longer matches what actually raised the error.
  let framesHtml = "";
  for (const frame of frames) {
    framesHtml += formatFrame(frame, capturedAt);
  }

  // ── Request info ──
  const requestPairs: Array<[string, string]> = [];
  if (request != null) {
    for (const attr of ["method", "url", "path", "ip"]) {
      requestPairs.push([attr, request[attr] != null ? String(request[attr]) : "(none)"]);
    }
    const dictFields: Array<[string, unknown]> = [
      ["headers", request.headers],
      ["params", request.params],
      ["query", request.query],
      ["body", request.body],
    ];
    for (const [label, val] of dictFields) {
      if (val != null && typeof val === "object" && Object.keys(val as object).length > 0) {
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          requestPairs.push([`${label}.${k}`, String(v)]);
        }
      } else if (val != null && typeof val === "string" && val !== "") {
        requestPairs.push([label, val]);
      } else {
        requestPairs.push([label, val == null ? "(none)" : "(empty)"]);
      }
    }
  }
  const requestSection = requestPairs.length > 0
    ? collapsible("Request Details", table(requestPairs))
    : "";

  // ── Environment ──
  const envPairs: Array<[string, string]> = [
    ["Framework", "Tina4 Node.js"],
    ["Node.js", process.version],
    ["Platform", process.platform],
    ["Arch", process.arch],
    ["Debug", process.env.TINA4_DEBUG ?? "false"],
    ["Log Level", process.env.TINA4_LOG_LEVEL ?? "ERROR"],
  ];
  const envSection = collapsible("Environment", table(envPairs));
  const stackSection = collapsible("Stack Trace", framesHtml, true);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tina4 Error — ${esc(excType)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:${BG};color:${TEXT};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px;line-height:1.5;}
</style>
</head>
<body>
<div style="max-width:960px;margin:0 auto;">
  <div style="margin-bottom:24px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
      <span style="background:${RED};color:${BG};padding:4px 12px;border-radius:4px;font-weight:700;font-size:13px;text-transform:uppercase;">Error</span>
      <span style="color:${SUBTEXT};font-size:14px;">Tina4 Debug Overlay</span>
    </div>
    <h1 style="color:${RED};font-size:28px;font-weight:700;margin-bottom:8px;">${esc(excType)}</h1>
    <p style="color:${TEXT};font-size:18px;font-family:'SF Mono','Fira Code','Consolas',monospace;background:${SURFACE};padding:12px 16px;border-radius:6px;border-left:4px solid ${RED};">${esc(excMsg)}</p>
  </div>
  ${stackSection}
  ${requestSection}
  ${envSection}
  <div style="margin-top:32px;padding-top:16px;border-top:1px solid ${OVERLAY};color:${SUBTEXT};font-size:12px;">
    Tina4 Debug Overlay &mdash; This page is only shown in debug mode. Set TINA4_DEBUG=false in production.
  </div>
</div>
</body>
</html>`;
}

/**
 * Render a safe, generic error page for production.
 */
export function renderProductionError(statusCode = 500, message = "Internal Server Error", path = ""): string {
  const codeColor = statusCode === 403 ? "#f59e0b" : statusCode === 404 ? "#3b82f6" : "#ef4444";
  const pathHtml = path ? `<div class="error-path">${esc(path)}</div><br>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${statusCode} — ${esc(message)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.error-card { background: #1e293b; border: 1px solid #334155; border-radius: 1rem; padding: 3rem; text-align: center; max-width: 520px; width: 90%; }
.error-code { font-size: 8rem; font-weight: 900; color: ${codeColor}; opacity: 0.6; line-height: 1; margin-bottom: 0.5rem; }
.error-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.75rem; }
.error-msg { color: #94a3b8; font-size: 1rem; margin-bottom: 1.5rem; line-height: 1.5; }
.error-path { font-family: 'SF Mono', monospace; background: #0f172a; color: ${codeColor}; padding: 0.5rem 1rem; border-radius: 0.5rem; font-size: 0.85rem; word-break: break-all; margin-bottom: 1.5rem; display: inline-block; }
.error-home { display: inline-block; padding: 0.6rem 2rem; background: #3b82f6; color: #fff; text-decoration: none; border-radius: 0.5rem; font-size: 0.9rem; font-weight: 600; }
.error-home:hover { opacity: 0.9; }
.logo { font-size: 1.5rem; margin-bottom: 1rem; opacity: 0.5; }
</style>
</head>
<body>
<div class="error-card">
    <div class="error-code">${statusCode}</div>
    <div class="error-title">${esc(message)}</div>
    <div class="error-msg">Something went wrong while processing your request.</div>
    ${pathHtml}
    <a href="/" class="error-home">Go Home</a>
</div>
</body>
</html>`;
}

/**
 * Check if TINA4_DEBUG is enabled.
 */
export function isDebugMode(): boolean {
  return isTruthy(process.env.TINA4_DEBUG);
}
