import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, Sso, SsoError } from "../packages/core/src/index.ts";

const required = Boolean(process.env.TINA4_REQUIRE_OIDC);
const issuer = process.env.TINA4_TEST_OIDC_ISSUER ?? "http://127.0.0.1:58080/realms/tina4-contract";
const options = { issuer, clientId: "tina4-app", clientSecret: "tina4-secret", redirectUri: "http://127.0.0.1:7148/auth/callback" };
const contract = JSON.parse(readFileSync(new URL("./fixtures/sso_contract.json", import.meta.url), "utf8"));
assert.equal(contract.adr, "ADR-0056");
assert.equal(contract.invariants.length, 10);

const sso = new Sso(options);
assert.equal(Sso.safeReturn("/dashboard"), "/dashboard");
assert.equal(Sso.safeReturn("https://evil.example"), "/");
assert.throws(() => new Sso({ ...options, issuer: "http://identity.example/realm" }), SsoError);
assert.throws(() => new Sso({ ...options, verify: "jwks" }), /cryptography capability/);

const directory = mkdtempSync(join(tmpdir(), "tina4-sso-"));
const session = new Session("file", { path: directory });
session.start();
session.set("cart", [42]);
session.set(Sso.PENDING_KEY, { state: "secret" });
session.set(Sso.SESSION_KEY, { access_token: "secret" });
assert.deepEqual(session.all(), { cart: [42] });
session.delete(Sso.PENDING_KEY);
session.delete(Sso.SESSION_KEY);

async function callbackQuery(loginUrl: string, callback: string): Promise<Record<string, string>> {
  const page = await fetch(loginUrl, { redirect: "manual" });
  const getSetCookie = (page.headers as any).getSetCookie?.bind(page.headers);
  const rawCookies: string[] = getSetCookie ? getSetCookie() : [page.headers.get("set-cookie") ?? ""];
  const cookies = rawCookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  const html = await page.text();
  const action = html.match(/<form[^>]+action="([^"]+)"[^>]*>/)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(action, "real provider login form was not found");
  const response = await fetch(action, {
    method: "POST", redirect: "manual", headers: {
      "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies,
    }, body: new URLSearchParams({ username: "andre", password: "tina4-pass", credentialId: "" }),
  });
  assert.ok([302, 303].includes(response.status), `provider login returned ${response.status}`);
  const location = response.headers.get("location");
  assert.ok(location?.startsWith(callback), "provider did not redirect to callback");
  return Object.fromEntries(new URL(location).searchParams.entries());
}

if (required) {
  const live = await Sso.fromIssuer(options);
  const oldId = session.getSessionId();
  const loginUrl = await live.login(session, "/dashboard");
  const login = new URL(loginUrl);
  assert.equal(login.searchParams.get("response_type"), "code");
  assert.equal(login.searchParams.get("code_challenge_method"), "S256");
  const result = await live.callback(session, await callbackQuery(loginUrl, live.redirectUri));
  assert.notEqual(session.getSessionId(), oldId);
  assert.deepEqual(session.get("cart"), [42]);
  assert.equal(result.return_to, "/dashboard");
  assert.equal(result.identity.username, "andre");
  assert.ok(result.identity.roles.includes("admin"));
  assert.ok(result.identity.roles.includes("developer"));
  assert.deepEqual(result.identity.groups, ["/engineering"]);
  assert.equal(session.all()[Sso.SESSION_KEY], undefined);
  const refreshed = await live.refresh(session);
  assert.equal(refreshed.subject, result.identity.subject);
  const logout = await live.logout(session);
  assert.equal(session.getSessionId(), null);
  assert.match(logout, /logout/);
  console.log("SSO contract: real OIDC PKCE/session/refresh/logout green");
} else {
  console.log("SSO contract: local surface green; real OIDC gate runs on lab");
}

rmSync(directory, { recursive: true, force: true });
console.log("Results: 1 passed, 0 failed");
