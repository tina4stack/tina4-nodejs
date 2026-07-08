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

  return false;
}
