/**
 * Customer feedback widget — Tier 4 port from tina4-python.
 *
 * End-users of a shipped Tina4 app give UX feedback via a floating bubble
 * widget. Widget visibility + API are gated by TWO env flags:
 *
 *   - TINA4_ENABLE_FEEDBACK   master switch (explicit opt-in)
 *   - TINA4_FEEDBACK_WHITELIST comma-separated emails / user IDs
 *
 * Architecture (mirrors Python `tina4_python/dev_admin/__init__.py`
 * lines 1440-1645):
 *
 *   1. Framework middleware injects <script src="/__feedback/widget.js">
 *      into HTML responses for whitelisted users only.
 *   2. Widget POSTs to /__feedback/api/turn for each conversational turn.
 *   3. That handler verifies whitelist + rate-limit, stamps the user
 *      identity server-side (client cannot fake `sender`), then forwards
 *      to the Rust agent's /feedback/intake.
 *
 * The widget is for END USERS of a shipped app — the /__dev paths get
 * skipped so the dev admin's own chat bubble doesn't sit on top of the
 * customer feedback bubble.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { authenticateRequest } from "./auth.js";
import { supervisorBaseUrl } from "./devAdmin.js";
import type { RouteHandler, Tina4Request } from "./types.js";
import type { Router } from "./router.js";

// ── Module-level rate-limit state ──────────────────────────────
// 5 turns/hour per identified user. Stored in-memory only; this is
// per-process — for multi-instance deployments a shared backend would
// be needed, but the python reference is the same shape.
const RATE_LIMIT_WINDOW_SEC = 3600;
const RATE_LIMIT_MAX = 5;
const _rateLimitHits = new Map<string, number[]>();

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Master switch — both this AND a non-empty whitelist must be set for
 * the widget to render or the API to accept submissions. Mirrors
 * Python's `_feedback_enabled()`.
 */
export function feedbackEnabled(): boolean {
  const raw = (process.env.TINA4_ENABLE_FEEDBACK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Comma-separated emails / user IDs in env, lowercased + trimmed.
 * Returns [] when the master switch is off so callers can short-circuit
 * with a single check. Mirrors Python's `_feedback_whitelist()`.
 */
export function feedbackWhitelist(): string[] {
  if (!feedbackEnabled()) return [];
  const raw = (process.env.TINA4_FEEDBACK_WHITELIST ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

/**
 * Best-effort user identity from JWT/Bearer auth. Falls back to
 * TINA4_FEEDBACK_DEV_USER (local dev convenience — lets the framework
 * owner test the widget without a full auth setup). Mirrors Python's
 * `_feedback_identify_user()`.
 */
export function feedbackIdentifyUser(request: Tina4Request): string | null {
  try {
    const payload = authenticateRequest(
      (request.headers ?? {}) as Record<string, string | string[] | undefined>,
    );
    if (payload && typeof payload === "object") {
      for (const key of ["email", "sub", "user_id"]) {
        const v = (payload as Record<string, unknown>)[key];
        if (v) return String(v).trim().toLowerCase();
      }
    }
  } catch {
    /* ignore — fall through to dev override */
  }
  const dev = (process.env.TINA4_FEEDBACK_DEV_USER ?? "").trim();
  if (dev) return dev.toLowerCase();
  return null;
}

/**
 * Returns [allowed, userId]. Both halves are required — feature off when
 * either is falsy. Mirrors Python's `_feedback_is_whitelisted()`.
 */
export function feedbackIsWhitelisted(
  request: Tina4Request,
): [boolean, string | null] {
  const wl = feedbackWhitelist();
  if (wl.length === 0) return [false, null];
  const user = feedbackIdentifyUser(request);
  if (!user) return [false, null];
  return [wl.includes(user), user];
}

/**
 * 5 turns/hour per user, sliding window. Prunes old timestamps lazily on
 * every call (no background task needed). Mirrors Python's
 * `_feedback_rate_limit_ok()`.
 */
export function feedbackRateLimitOk(user: string): boolean {
  const now = Date.now() / 1000;
  const prior = _rateLimitHits.get(user) ?? [];
  const fresh = prior.filter((t) => now - t < RATE_LIMIT_WINDOW_SEC);
  if (fresh.length >= RATE_LIMIT_MAX) {
    _rateLimitHits.set(user, fresh);
    return false;
  }
  fresh.push(now);
  _rateLimitHits.set(user, fresh);
  return true;
}

/** Test-only: clear rate-limit state between cases. Not part of public API. */
export function _resetFeedbackRateLimit(): void {
  _rateLimitHits.clear();
}

/**
 * Insert the widget <script> into HTML for whitelisted users. Called
 * from the response pipeline right before the body is flushed. No-op if:
 *   - request path starts with /__dev or /__feedback (developer
 *     pages have their own chat trigger)
 *   - master switch / whitelist not set
 *   - user not in whitelist
 *   - html lacks </body>
 * Idempotent — looks for the `data-tina4-feedback` marker and bails.
 * Mirrors Python's `inject_feedback_widget()`.
 */
export function injectFeedbackWidget(
  request: Tina4Request,
  html: string,
): string {
  if (!html) return html;
  const path = (request.path ?? "") || "";
  if (path.startsWith("/__dev") || path.startsWith("/__feedback")) return html;
  if (html.includes("data-tina4-feedback")) return html;
  const [allowed] = feedbackIsWhitelisted(request);
  if (!allowed) return html;
  const lastBody = html.lastIndexOf("</body>");
  if (lastBody < 0) return html;
  const snippet =
    '<script src="/__feedback/widget.js" data-tina4-feedback></script>';
  return html.slice(0, lastBody) + snippet + html.slice(lastBody);
}

// ── Route handlers ──────────────────────────────────────────────

/**
 * POST /__feedback/api/turn — proxy one conversational turn to the Rust
 * agent's `/feedback/intake`. Server stamps `sender` from the verified
 * identity so the client cannot inject who they are. Mirrors Python's
 * `_api_feedback_turn()`.
 */
export const handleFeedbackTurn: RouteHandler = async (req, res) => {
  const [allowed, user] = feedbackIsWhitelisted(req);
  if (!allowed || !user) {
    res.json({ error: "not authorised for feedback" }, 403);
    return;
  }
  if (!feedbackRateLimitOk(user)) {
    res.json(
      {
        error: "rate limit exceeded",
        hint: `max ${RATE_LIMIT_MAX} turns per hour`,
      },
      429,
    );
    return;
  }

  const body = (req as Tina4Request).body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.json({ error: "expected JSON body" }, 400);
    return;
  }

  // Stamp sender server-side — client cannot override identity.
  const forwardBody = { ...(body as Record<string, unknown>), sender: user };
  const base = supervisorBaseUrl();
  const target = `${base}/feedback/intake`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60_000);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardBody),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    res.json(
      { error: "agent unreachable", detail: (e as Error).message },
      502,
    );
    return;
  }
  clearTimeout(timer);

  const raw = await upstream.text();
  const status = upstream.status || 200;
  try {
    res.json(JSON.parse(raw), status);
  } catch {
    res.raw.writeHead(status, {
      "Content-Type":
        upstream.headers.get("content-type") ?? "text/plain; charset=utf-8",
    });
    res.raw.end(raw);
  }
};

// Widget bundle lives at packages/core/src/__feedback/widget.js so that
// it isn't auto-served by the static-file handler (which would skip the
// no-cache headers below).
const __feedbackDirname = dirname(fileURLToPath(import.meta.url));
const WIDGET_BUNDLE_PATH = resolve(__feedbackDirname, "__feedback", "widget.js");

/**
 * GET /__feedback/widget.js — serve the widget bundle with no-cache
 * headers so a broken bundle doesn't get stuck in browser caches.
 * Mirrors Python's `_api_feedback_widget_js()`.
 */
export const handleFeedbackWidgetJs: RouteHandler = (_req, res) => {
  let body: Buffer | string;
  if (existsSync(WIDGET_BUNDLE_PATH)) {
    body = readFileSync(WIDGET_BUNDLE_PATH);
  } else {
    body = "console.warn('tina4-feedback-widget bundle not built yet');";
  }
  res.raw.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-cache, must-revalidate",
    Pragma: "no-cache",
  });
  res.raw.end(body);
};

/**
 * Register the two feedback routes on a Router. Called from the dev
 * admin setup so the routes only exist when the dev surface is
 * enabled — production deployments without TINA4_DEBUG also skip them.
 */
export function registerFeedbackRoutes(router: Router): void {
  router.addRoute({
    method: "POST",
    pattern: "/__feedback/api/turn",
    handler: handleFeedbackTurn,
  });
  router.addRoute({
    method: "GET",
    pattern: "/__feedback/widget.js",
    handler: handleFeedbackWidgetJs,
  });
}

// Re-export the bundle path so other tools (e.g. CLI builds) can find it.
export { WIDGET_BUNDLE_PATH };
// Silence unused-import lint where the helpers are imported but `join` isn't
// used in this file's current code path. (Kept available for future tweaks.)
void join;
