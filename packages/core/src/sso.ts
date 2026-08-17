/** Provider-neutral, configuration-first OpenID Connect SSO. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Router } from "./router.js";

export class SsoError extends Error {}

type Json = Record<string, any>;
type SessionLike = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  regenerate(): string;
  destroy(): void;
};

export interface SsoOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
  verify?: "introspection" | "jwks";
  postLogoutRedirectUri?: string;
  claimMap?: Record<string, string>;
  timeout?: number;
}

export class Sso {
  static readonly PENDING_KEY = "_tina4_sso_pending";
  static readonly SESSION_KEY = "_tina4_sso";
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scopes: string[];
  readonly verify: "introspection" | "jwks";
  readonly postLogoutRedirectUri?: string;
  readonly claimMap: Record<string, string>;
  readonly timeout: number;
  private metadata: Json = {};
  private static mountedRouters = new WeakSet<Router>();

  constructor(options: SsoOptions = {}) {
    this.issuer = (options.issuer ?? process.env.TINA4_SSO_ISSUER ?? "").replace(/\/$/, "");
    this.clientId = options.clientId ?? process.env.TINA4_SSO_CLIENT_ID ?? "";
    this.clientSecret = options.clientSecret ?? process.env.TINA4_SSO_CLIENT_SECRET;
    this.redirectUri = options.redirectUri ?? process.env.TINA4_SSO_REDIRECT_URI ?? "";
    this.scopes = options.scopes ?? this.jsonEnv("TINA4_SSO_SCOPES", ["openid", "profile", "email"]);
    this.verify = options.verify ?? (process.env.TINA4_SSO_VERIFY as any) ?? "introspection";
    this.postLogoutRedirectUri = options.postLogoutRedirectUri ?? process.env.TINA4_SSO_POST_LOGOUT_REDIRECT_URI;
    this.claimMap = options.claimMap ?? this.jsonEnv("TINA4_SSO_CLAIM_MAP", {});
    this.timeout = options.timeout ?? 10_000;
    this.validateConfig();
  }

  static async fromIssuer(options: SsoOptions = {}): Promise<Sso> {
    const value = new Sso(options);
    await value.discover();
    return value;
  }

  static configured(): boolean {
    return ["TINA4_SSO_ISSUER", "TINA4_SSO_CLIENT_ID", "TINA4_SSO_REDIRECT_URI"]
      .every((key) => Boolean(process.env[key]));
  }

  private jsonEnv<T>(name: string, fallback: T): T {
    const raw = process.env[name];
    if (!raw) return fallback;
    try { return JSON.parse(raw) as T; }
    catch { throw new SsoError(`${name} must be valid JSON`); }
  }

  private static secureUrl(value: string, name: string): void {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new SsoError(`${name} must be an absolute URL`); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new SsoError(`${name} must use HTTPS except on loopback`);
    }
  }

  private validateConfig(): void {
    if (!this.issuer || !this.clientId || !this.redirectUri) {
      throw new SsoError("TINA4_SSO_ISSUER, TINA4_SSO_CLIENT_ID and TINA4_SSO_REDIRECT_URI are required");
    }
    Sso.secureUrl(this.issuer, "issuer");
    Sso.secureUrl(this.redirectUri, "redirect URI");
    if (!["introspection", "jwks"].includes(this.verify)) throw new SsoError("TINA4_SSO_VERIFY must be introspection or jwks");
    if (this.verify === "jwks") throw new SsoError("jwks verification requires an installed cryptography capability");
    if (this.verify === "introspection" && !this.clientSecret) throw new SsoError("introspection verification requires TINA4_SSO_CLIENT_SECRET");
    if (!Array.isArray(this.scopes) || !this.scopes.includes("openid")) throw new SsoError("TINA4_SSO_SCOPES must be a list containing openid");
  }

  private async requestJson(url: string, form?: Json, bearer?: string, basic = false): Promise<Json> {
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (form) {
      const parameters = new URLSearchParams();
      for (const [key, value] of Object.entries(form)) parameters.set(key, String(value));
      body = parameters.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    if (basic) headers.Authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(url, { method: form ? "POST" : "GET", headers, body, signal: controller.signal });
      if (!response.ok) throw new SsoError("OIDC provider request failed");
      const result = await response.json();
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new SsoError("OIDC provider returned a non-object response");
      return result as Json;
    } catch (error) {
      if (error instanceof SsoError) throw error;
      throw new SsoError("OIDC provider request failed");
    } finally { clearTimeout(timer); }
  }

  async discover(force = false): Promise<Json> {
    if (Object.keys(this.metadata).length && !force) return { ...this.metadata };
    const result = await this.requestJson(`${this.issuer}/.well-known/openid-configuration`);
    if (result.issuer !== this.issuer) throw new SsoError("OIDC discovery issuer does not exactly match configuration");
    const required = ["authorization_endpoint", "token_endpoint"];
    if (this.verify === "introspection") required.push("introspection_endpoint");
    for (const key of required) {
      if (!result[key]) throw new SsoError(`OIDC discovery is missing ${key}`);
      Sso.secureUrl(result[key], key);
    }
    this.metadata = result;
    return { ...result };
  }

  static safeReturn(value?: string): string {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
    return [...value].some((char) => char.charCodeAt(0) < 32) ? "/" : value;
  }

  private session(value: any): SessionLike | null { return (value?.session ?? value) as SessionLike | null; }

  async login(requestOrSession: any, returnTo = "/"): Promise<string> {
    const session = this.session(requestOrSession);
    if (!session) throw new SsoError("SSO login requires a Tina4 Session");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    session.set(Sso.PENDING_KEY, { state, nonce, verifier, return_to: Sso.safeReturn(returnTo), created_at: Math.floor(Date.now() / 1000) });
    const metadata = await this.discover();
    const query = new URLSearchParams({
      client_id: this.clientId, redirect_uri: this.redirectUri, response_type: "code",
      scope: this.scopes.join(" "), state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    });
    return `${metadata.authorization_endpoint}?${query}`;
  }

  private static equal(left: unknown, right: unknown): boolean {
    const a = Buffer.from(String(left ?? "")); const b = Buffer.from(String(right ?? ""));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private static jwtPayload(token: string): Json {
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
    catch { throw new SsoError("provider returned an invalid ID token"); }
  }

  private async introspect(accessToken: string): Promise<Json> {
    const metadata = await this.discover();
    const result = await this.requestJson(metadata.introspection_endpoint, { token: accessToken, token_type_hint: "access_token" }, undefined, true);
    if (result.active !== true || result.iss !== this.issuer) throw new SsoError("OIDC access token is inactive or has the wrong issuer");
    const audience = result.aud ?? result.client_id;
    const valid = (Array.isArray(audience) ? audience.includes(this.clientId) : audience === this.clientId) || result.client_id === this.clientId;
    if (!valid) throw new SsoError("OIDC token audience mismatch");
    return result;
  }

  private claim(claims: Json, configured: string | undefined, fallback: string): any {
    let value: any = claims;
    for (const part of (configured ?? fallback).split(".")) value = value && typeof value === "object" ? value[part] : undefined;
    return value;
  }

  private normalize(claims: Json): Json {
    const subject = this.claim(claims, this.claimMap.subject, "sub");
    const issuer = this.claim(claims, this.claimMap.issuer, "iss") ?? this.issuer;
    if (!subject || issuer !== this.issuer) throw new SsoError("OIDC identity is missing a valid issuer or subject");
    const roles = [...(this.claim(claims, this.claimMap.roles, "realm_access.roles") ?? []), ...(claims.resource_access?.[this.clientId]?.roles ?? [])];
    const groups = this.claim(claims, this.claimMap.groups, "groups") ?? [];
    return {
      issuer, subject,
      username: this.claim(claims, this.claimMap.username, "preferred_username") ?? null,
      email: this.claim(claims, this.claimMap.email, "email") ?? null,
      name: this.claim(claims, this.claimMap.name, "name") ?? null,
      roles: [...new Set(roles.map(String))].sort(), groups: [...new Set(groups.map(String))].sort(),
    };
  }

  async callback(requestOrSession: any, query?: Json): Promise<{ identity: Json; return_to: string }> {
    const session = this.session(requestOrSession);
    const values = query ?? requestOrSession?.query ?? {};
    const pending = session?.get(Sso.PENDING_KEY) as Json | undefined;
    session?.delete(Sso.PENDING_KEY);
    if (!pending || !values.code || !Sso.equal(values.state, pending.state)) throw new SsoError("OIDC callback state is invalid or already consumed");
    if (Math.floor(Date.now() / 1000) - Number(pending.created_at ?? 0) > 600) throw new SsoError("OIDC callback state has expired");
    const metadata = await this.discover();
    const tokens = await this.requestJson(metadata.token_endpoint, {
      grant_type: "authorization_code", code: values.code, redirect_uri: this.redirectUri,
      client_id: this.clientId, code_verifier: pending.verifier,
    }, undefined, Boolean(this.clientSecret));
    if (!tokens.access_token || !tokens.id_token) throw new SsoError("OIDC token response is incomplete");
    if (this.verify === "jwks") throw new SsoError("JWKS verification requires an installed cryptography capability");
    const claims = await this.introspect(tokens.access_token);
    if (!Sso.equal(Sso.jwtPayload(tokens.id_token).nonce, pending.nonce)) throw new SsoError("OIDC ID token nonce mismatch");
    if (metadata.userinfo_endpoint) Object.assign(claims, await this.requestJson(metadata.userinfo_endpoint, undefined, tokens.access_token));
    const identity = this.normalize(claims);
    session!.regenerate();
    session!.set(Sso.SESSION_KEY, {
      version: 1, identity, access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, expires_at: Math.floor(Date.now() / 1000) + Number(tokens.expires_in ?? 0),
    });
    return { identity, return_to: Sso.safeReturn(pending.return_to) };
  }

  identity(requestOrSession: any): Json | null {
    const stored = this.session(requestOrSession)?.get(Sso.SESSION_KEY) as Json | undefined;
    const identity = stored?.identity ?? null;
    if (identity && requestOrSession?.session) requestOrSession.user = identity;
    return identity;
  }

  async refresh(requestOrSession: any): Promise<Json> {
    const session = this.session(requestOrSession);
    const stored = session?.get(Sso.SESSION_KEY) as Json | undefined;
    if (!stored?.refresh_token) { session?.delete(Sso.SESSION_KEY); throw new SsoError("OIDC session cannot be refreshed"); }
    try {
      const metadata = await this.discover();
      const tokens = await this.requestJson(metadata.token_endpoint, {
        grant_type: "refresh_token", refresh_token: stored.refresh_token, client_id: this.clientId,
      }, undefined, Boolean(this.clientSecret));
      const claims = await this.introspect(tokens.access_token);
      if (metadata.userinfo_endpoint) Object.assign(claims, await this.requestJson(metadata.userinfo_endpoint, undefined, tokens.access_token));
      const identity = this.normalize(claims);
      session!.set(Sso.SESSION_KEY, { ...stored, identity, access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? stored.refresh_token, id_token: tokens.id_token ?? stored.id_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(tokens.expires_in ?? 0) });
      return identity;
    } catch (error) { session?.delete(Sso.SESSION_KEY); throw error; }
  }

  async logout(requestOrSession: any, returnTo = "/"): Promise<string> {
    const session = this.session(requestOrSession);
    const stored = session?.get(Sso.SESSION_KEY) as Json | undefined;
    session?.destroy();
    const endpoint = (await this.discover()).end_session_endpoint;
    const target = this.postLogoutRedirectUri ?? Sso.safeReturn(returnTo);
    if (!endpoint) return target;
    const params = new URLSearchParams({ post_logout_redirect_uri: target, client_id: this.clientId });
    if (stored?.id_token) params.set("id_token_hint", stored.id_token);
    return `${endpoint}?${params}`;
  }

  static async mountConfigured(router: Router): Promise<boolean> {
    if (Sso.mountedRouters.has(router) || !Sso.configured()) return false;
    const owned = new Set(["GET /auth/login", "GET /auth/callback", "POST /auth/logout"]);
    const collisions = router.getRoutes()
      .map((route) => `${route.method} ${route.pattern}`)
      .filter((route) => owned.has(route));
    if (collisions.length) throw new SsoError(`SSO route collision: ${collisions.join(", ")}`);
    const sso = await Sso.fromIssuer();
    router.get("/auth/login", async (req, res) => res.redirect(await sso.login(req, (req.query as any)?.return_to ?? "/")));
    router.get("/auth/callback", async (req, res) => {
      try { return res.redirect((await sso.callback(req)).return_to); }
      catch (error) {
        const message = error instanceof SsoError ? error.message : "OIDC callback failed";
        return res.error("SSO_CALLBACK_FAILED", message, 400);
      }
    });
    router.post("/auth/logout", async (req, res) => res.redirect(await sso.logout(req, (req.query as any)?.return_to ?? "/")));
    Sso.mountedRouters.add(router);
    return true;
  }
}

export { Sso as SSO };
