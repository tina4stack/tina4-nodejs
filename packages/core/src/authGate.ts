/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Secure-by-default route auth gate — shared by the live server dispatch and the
 * in-process TestClient so the test surface enforces the IDENTICAL gate as
 * production.
 *
 * The TestClient used to match a route and run its handler directly, skipping
 * this check, so a tokenless write returned the handler's 201 in a test while
 * the live server returned 401 — a green test hid a live failure and the
 * verification layer lied. This is the same defect fixed in tina4-python under
 * #PY2; extracting the gate here lets both callers share one implementation.
 */
import { validToken, refreshToken, isIdentityPayload } from "./auth.js";
import { liveSessionIdentity } from "./ssoIdentity.js";
import type { Tina4Request, Tina4Response } from "./types.js";

/** Just the auth-relevant fields of a matched route. */
export interface AuthGateRoute {
  secure?: boolean;
  noAuth?: boolean;
  /** RBAC guard groups (Feature 138): OR within a group, AND across groups. */
  requiredRoles?: string[][];
  requiredPerms?: string[][];
}

/**
 * A rejection the caller must RENDER (ERR-DEC-02, #342). The gate decides the
 * status and message but does NOT render — the template engine stays out of the
 * auth path's import graph (the auth path imports only node: builtins; see
 * test/authRs256OptIn.test.ts). server.ts, which already depends on Frond,
 * renders this through the shared negotiated renderer.
 */
export interface AuthReject {
  status: number;
  message: string;
}

/**
 * Enforce auth for a matched route.
 *
 * Returns an `AuthReject` (status + message) when the request is REJECTED — the
 * caller must render it and stop (not run the handler). Returns `null` when the
 * route is public OR a valid token was presented (in which case `req.user` is
 * populated and, for a body formToken, a `FreshToken` header is set). Auth is
 * enforced only for a route that is `secure` and not `noAuth` (the dev
 * dashboard registers its own routes `noAuth`).
 *
 * The gate deliberately does NOT render the rejection: rendering needs the
 * template engine, and the auth path's import graph must stay node:-builtins
 * only (#342). server.ts renders what this returns.
 *
 * Token sources, in priority order: `Authorization: Bearer` header, a
 * `formToken` in the parsed body, then a session token.
 */
export function enforceRouteAuth(
  req: Tina4Request,
  res: Tina4Response,
  match: AuthGateRoute,
): AuthReject | null {
  if (!(match.secure === true && match.noAuth !== true)) {
    return null;
  }

  // Token slots in priority order: Bearer header, body formToken (frond.js
  // puts the auth token it received as a FreshToken there), session token.
  // Each slot is accepted only when it carries an IDENTITY token: a Frond
  // form token (`type: "form"`) proves where a write came from, not who sent
  // it, so it is skipped and the search moves on (ADR-0079 s1).
  const authHeader = req.headers.authorization ?? "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  let payload: Record<string, unknown> | null = null;
  let tokenSource: "header" | "body" | "session" | "" = "";
  let resolvedToken = "";

  // Priority 1: Authorization Bearer header
  if (headerToken) {
    const candidate = validToken(headerToken);
    if (isIdentityPayload(candidate)) { payload = candidate; tokenSource = "header"; resolvedToken = headerToken; }
  }

  // Priority 2: formToken from request body
  if (!payload) {
    const bodyToken = (req.body as Record<string, unknown>)?.formToken as string | undefined;
    if (bodyToken) {
      const candidate = validToken(bodyToken);
      if (isIdentityPayload(candidate)) { payload = candidate; tokenSource = "body"; resolvedToken = bodyToken; }
    }
  }

  // Priority 3: Session — a provider-verified SSO identity while it is live
  // (ADR-0079 s5), then the session token.
  if (!payload) {
    const identity = liveSessionIdentity((req as any).session?.get?.("_tina4_sso"));
    if (identity) {
      req.user = identity;
      // RBAC guards apply to the SSO identity too (Feature 138).
      return rbacForbidden(match, identity);
    }
    const sessionToken = (req as any).session?.get?.("token") as string | undefined;
    if (sessionToken) {
      const candidate = validToken(sessionToken);
      if (isIdentityPayload(candidate)) { payload = candidate; tokenSource = "session"; resolvedToken = sessionToken; }
    }
  }

  if (!payload) {
    // ERR-DEC-02 (#342): the caller negotiates — a browser gets errors/401.twig,
    // an API client the JSON envelope. Was an unconditional raw JSON write here.
    return { status: 401, message: "Unauthorized" };
  }

  req.user = payload;

  // When a body token authenticates, return a FreshToken header with a refreshed JWT
  if (tokenSource === "body") {
    const fresh = refreshToken(resolvedToken);
    if (fresh) {
      res.header("FreshToken", fresh);
    }
  }

  // ── RBAC guards (Feature 138): authorization AFTER authentication ──
  // Auth has passed (401 ruled out above). If the route carries role/permission
  // guards, the verified payload must satisfy them, else 403.
  return rbacForbidden(match, req.user);
}

/** Read a claim as a list of strings; coerce a legacy singular string. */
function rbacClaimList(subject: Record<string, unknown>, key: string, legacy?: string): string[] {
  const coerce = (v: unknown): string[] => {
    if (typeof v === "string") return v === "" ? [] : [v];
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((x) => x !== "");
    return [];
  };
  let out = coerce(subject[key]);
  if (out.length === 0 && legacy) out = coerce(subject[legacy]);
  return out;
}

/**
 * True if any GRANTED permission satisfies the concrete REQUIRED one.
 * `*` grants everything; `posts.*` grants `posts.<...>` on the dot boundary.
 */
function rbacPermGranted(granted: string[], required: string): boolean {
  return granted.some(
    (g) => g === "*" || g === required || (g.endsWith(".*") && required.startsWith(g.slice(0, -1))),
  );
}

/**
 * Write a 403 and return `true` when a route's RBAC guards are not satisfied by
 * the verified payload; return `false` (no write) when authorised or unguarded.
 * AND across guard groups, OR within a group. Feature 138 / ADR-0058.
 */
function rbacForbidden(match: AuthGateRoute, payload: unknown): AuthReject | null {
  const requiredRoles = match.requiredRoles ?? [];
  const requiredPerms = match.requiredPerms ?? [];
  if (requiredRoles.length === 0 && requiredPerms.length === 0) {
    return null;
  }
  const subject =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  // ERR-DEC-02 (#342): the caller negotiates the 403 (HTML page vs JSON
  // envelope) — the gate only decides the refusal.
  const forbidden: AuthReject = { status: 403, message: "Forbidden" };
  const roles = rbacClaimList(subject, "roles", "role");
  for (const group of requiredRoles) {
    if (!group.some((r) => roles.includes(r))) return forbidden;
  }
  const perms = rbacClaimList(subject, "permissions");
  for (const group of requiredPerms) {
    if (!group.some((p) => rbacPermGranted(perms, p))) return forbidden;
  }
  return null;
}
