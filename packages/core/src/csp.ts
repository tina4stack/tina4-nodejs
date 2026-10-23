// Copyright (c) 2026 Code Infinity
// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-response Content-Security-Policy nonce (ADR-0088).
 *
 * The framework serves a strict default CSP (`default-src 'self'`). A browser
 * refuses every inline `<style>` and `<script>` under that policy unless the
 * element carries a nonce that the `Content-Security-Policy` header also names.
 * So the framework mints one cryptographically-random nonce per response, stamps
 * it on every inline `<style>`/`<script>` it emits, and injects the matching
 * `'nonce-<X>'` into the `style-src` and `script-src` directives of the CSP
 * header. The same value reaches user templates through the Frond global
 * `csp_nonce()` and routes through `response.cspNonce`.
 *
 * The nonce lives in an `AsyncLocalStorage`, the same Node adaptation of a
 * per-request contextvar the logger uses for the request id (Decision 12).
 * `runDispatch()` establishes a fresh nonce for the whole request, so the inline
 * HTML body and the security middleware both read the SAME value across every
 * await, and two requests interleaving on the one event loop never read each
 * other's. Whoever touches the nonce first in a request - the body emitter or the
 * header builder - gets the same value, because `currentCspNonce()` mints one on
 * first access and caches it for the rest of the request.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// The per-request nonce. `undefined` until a request (or the first emitter /
// header call) sets one. A fallback covers code that runs outside any request
// scope (a script, a test), exactly as the logger's request-id fallback does.
const nonceStore = new AsyncLocalStorage<{ nonce: string | undefined }>();
let nonceFallback: string | undefined;

/** Return a fresh cryptographically-random nonce (128 bits, base64). */
export function generateNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Run `fn` with `nonce` established as the request-scoped CSP nonce. */
export function runWithCspNonce<T>(nonce: string, fn: () => T): T {
  return nonceStore.run({ nonce }, fn);
}

/** Set the nonce for the current request context (mirrors Log.setRequestId). */
export function setCurrentNonce(nonce: string | undefined): void {
  const store = nonceStore.getStore();
  if (store) store.nonce = nonce;
  else nonceFallback = nonce;
}

/** Clear the nonce (mirrors Log.clearRequestId); the scope ends on its own. */
export function clearCurrentNonce(): void {
  setCurrentNonce(undefined);
}

/**
 * Return the current request's nonce, minting one on first access.
 *
 * Generate-on-first-access makes the value independent of ordering: whether the
 * inline body or the CSP header is built first, both read the same nonce.
 */
export function currentCspNonce(): string {
  const store = nonceStore.getStore();
  let value = store ? store.nonce : nonceFallback;
  if (!value) {
    value = generateNonce();
    if (store) store.nonce = value;
    else nonceFallback = value;
  }
  return value;
}

/**
 * Frond global `csp_nonce()`: the current response's CSP nonce.
 *
 * Use it on any inline element a template emits:
 *
 *   <style nonce="{{ csp_nonce() }}"> ... </style>
 *   <script nonce="{{ csp_nonce() }}"> ... </script>
 */
export function cspNonce(): string {
  return currentCspNonce();
}

/**
 * Return `csp` with `'nonce-<nonce>'` present in style-src AND script-src.
 *
 * For the default `default-src 'self'` this yields
 * `default-src 'self'; style-src 'self' 'nonce-X'; script-src 'self' 'nonce-X'`.
 * When a directive is absent it is derived from `default-src` (falling back to
 * `'self'`) so the framework's own nonce'd content always works; when present
 * the nonce is appended (idempotently). Every other directive is kept, in order.
 */
/**
 * Add the nonce to one directive, deriving an absent one from default-src.
 *
 * ADR-0100: a directive whose resolved value - present, or the default-src it
 * falls back to - already carries 'unsafe-inline' is the app's explicit opt-in
 * to inline. A browser ignores 'unsafe-inline' the moment a nonce joins the same
 * directive (CSP Level 2+), so a nonce here would silently block the inline the
 * app asked for; leave it, the app's choice wins. Otherwise the nonce is added
 * idempotently, and an absent directive is spawned from default-src so the
 * framework's own inline runs.
 */
function applyNonceToDirective(
  directives: Array<[string, string]>,
  directive: string,
  defaultValue: string,
  token: string,
): void {
  const existing = directives.find(([name]) => name === directive);
  const resolved = (existing ? existing[1] : defaultValue).split(/\s+/);
  if (resolved.includes("'unsafe-inline'")) return;
  if (!existing) {
    directives.push([directive, `${defaultValue} ${token}`.trim()]);
  } else if (!resolved.includes(token)) {
    existing[1] = `${existing[1]} ${token}`.trim();
  }
}

export function injectNonceIntoCsp(csp: string, nonce: string): string {
  const token = `'nonce-${nonce}'`;
  const directives: Array<[string, string]> = [];
  for (const rawPart of csp.split(";")) {
    const part = rawPart.trim();
    if (!part) continue;
    const spaceAt = part.search(/\s/);
    const name = (spaceAt === -1 ? part : part.slice(0, spaceAt)).toLowerCase();
    const value = spaceAt === -1 ? "" : part.slice(spaceAt + 1).trim();
    directives.push([name, value]);
  }

  const defaultEntry = directives.find(([name]) => name === "default-src");
  const defaultValue = defaultEntry && defaultEntry[1] ? defaultEntry[1] : "'self'";

  for (const directive of ["style-src", "script-src"]) {
    applyNonceToDirective(directives, directive, defaultValue, token);
  }

  return directives
    .map(([name, value]) => (value ? `${name} ${value}` : name))
    .join("; ");
}

/**
 * Build the CSP header value for `nonce` from the environment.
 *
 * Honours `TINA4_CSP` (default `default-src 'self'`) and always injects the
 * nonce into style-src and script-src. An empty `TINA4_CSP` is treated as the
 * default policy, matching how the warn-once gate reads "unset".
 */
export function resolveCspHeader(nonce: string): string {
  const csp = process.env.TINA4_CSP || "default-src 'self'";
  return injectNonceIntoCsp(csp, nonce);
}
