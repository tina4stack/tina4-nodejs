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
import { validToken, getPayload, refreshToken } from "./auth.js";
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
 * Enforce auth for a matched route.
 *
 * Returns `true` when the request is REJECTED — a 401 has already been written
 * to `res.raw` and the caller must stop (not run the handler). Returns `false`
 * when the route is public OR a valid token was presented (in which case
 * `req.user` is populated and, for a body formToken, a `FreshToken` header is
 * set). Auth is enforced only for a route that is `secure` and not `noAuth`,
 * and never for `/__dev` dev-admin routes.
 *
 * Token sources, in priority order: `Authorization: Bearer` header, a
 * `formToken` in the parsed body, then a session token.
 */
export function enforceRouteAuth(
  req: Tina4Request,
  res: Tina4Response,
  match: AuthGateRoute,
  isDevAdmin: boolean,
): boolean {
  if (!(match.secure === true && match.noAuth !== true && !isDevAdmin)) {
    return false;
  }

  const authHeader = req.headers.authorization ?? "";
  const headerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  let resolvedToken = "";
  let tokenSource: "header" | "body" | "session" | "" = "";

  // Priority 1: Authorization Bearer header
  if (headerToken && validToken(headerToken)) {
    resolvedToken = headerToken;
    tokenSource = "header";
  }

  // Priority 2: formToken from request body
  if (!resolvedToken) {
    const bodyToken = (req.body as Record<string, unknown>)?.formToken as string | undefined;
    if (bodyToken && validToken(bodyToken)) {
      resolvedToken = bodyToken;
      tokenSource = "body";
    }
  }

  // Priority 3: Session token
  if (!resolvedToken) {
    const sso = (req as any).session?.get?.("_tina4_sso") as Record<string, any> | undefined;
    const identity = sso?.identity;
    if (identity?.issuer && identity?.subject) {
      req.user = identity;
      // RBAC guards apply to the SSO identity too (Feature 138).
      return rbacForbidden(match, identity, res);
    }
    const sessionToken = (req as any).session?.get?.("token") as string | undefined;
    if (sessionToken && validToken(sessionToken)) {
      resolvedToken = sessionToken;
      tokenSource = "session";
    }
  }

  if (!resolvedToken) {
    res.raw.writeHead(401, { "Content-Type": "application/json" });
    res.raw.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  req.user = getPayload(resolvedToken) ?? {};

  // When a body formToken validates, return a FreshToken header with a refreshed JWT
  if (tokenSource === "body") {
    const fresh = refreshToken(resolvedToken);
    if (fresh) {
      res.header("FreshToken", fresh);
    }
  }

  // ── RBAC guards (Feature 138): authorization AFTER authentication ──
  // Auth has passed (401 ruled out above). If the route carries role/permission
  // guards, the verified payload must satisfy them, else 403.
  return rbacForbidden(match, req.user, res);
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
function rbacForbidden(match: AuthGateRoute, payload: unknown, res: Tina4Response): boolean {
  const requiredRoles = match.requiredRoles ?? [];
  const requiredPerms = match.requiredPerms ?? [];
  if (requiredRoles.length === 0 && requiredPerms.length === 0) {
    return false;
  }
  const subject =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  const roles = rbacClaimList(subject, "roles", "role");
  for (const group of requiredRoles) {
    if (!group.some((r) => roles.includes(r))) return writeForbidden(res);
  }
  const perms = rbacClaimList(subject, "permissions");
  for (const group of requiredPerms) {
    if (!group.some((p) => rbacPermGranted(perms, p))) return writeForbidden(res);
  }
  return false;
}

function writeForbidden(res: Tina4Response): boolean {
  res.raw.writeHead(403, { "Content-Type": "application/json" });
  res.raw.end(JSON.stringify({ error: "Forbidden" }));
  return true;
}
