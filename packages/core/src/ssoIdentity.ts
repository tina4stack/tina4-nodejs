/**
 * The stored SSO identity, only while it is live (ADR-0079 s5). `stored` is the
 * reserved _tina4_sso session value. The identity needs an issuer and a
 * subject, and a numeric expires_at that is 0 (the provider gave no lifetime)
 * or still in the future.
 *
 * Its own dependency-free module, so the auth gate can use it without
 * importing the OIDC client (and everything the client imports).
 */
export function liveSessionIdentity(stored: unknown): Record<string, any> | null {
  if (!stored || typeof stored !== "object") return null;
  const identity = (stored as Record<string, any>).identity;
  if (!identity || typeof identity !== "object" || !identity.issuer || !identity.subject) return null;
  const expiresAt = (stored as Record<string, any>).expires_at ?? 0;
  if (typeof expiresAt !== "number") return null;
  if (expiresAt > 0 && Math.floor(Date.now() / 1000) >= expiresAt) return null;
  return identity;
}

