/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * CSP nonce respects a user's 'unsafe-inline' (ADR-0100, refines ADR-0088).
 *
 * A browser ignores 'unsafe-inline' in any directive that also lists a nonce
 * (CSP Level 2+). Since 3.13.143 the framework appended its per-response nonce
 * to script-src/style-src unconditionally - including an app's own TINA4_CSP -
 * so an app that deliberately allowed inline through 'unsafe-inline' had it
 * silently blocked (tina4-php#330). The rule now: a directive (present, or
 * derived from default-src) that already carries 'unsafe-inline' gets NO nonce;
 * the app's explicit choice wins. The strict default policy is unchanged and
 * still nonced.
 *
 * Answer key: tina4-documentation/plan/v3/fixtures/securityheaders_contract.json,
 * invariant csp-nonce-respects-unsafe-inline. NO MOCKS - the real injector, a
 * pure string transform.
 */
import { injectNonceIntoCsp } from "../packages/core/src/index.ts";

const NONCE = "abc123";
const TOKEN = "'nonce-abc123'";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
  }
}

function directive(csp: string, name: string): string {
  for (const part of csp.split(";").map((p) => p.trim())) {
    if (part.split(/\s+/)[0].toLowerCase() === name) return part;
  }
  return "";
}

console.log("=== CSP nonce respects unsafe-inline (ADR-0100) ===\n");

let out = injectNonceIntoCsp("default-src 'self'; script-src 'self' 'unsafe-inline'", NONCE);
check(
  "explicit unsafe-inline script-src keeps unsafe-inline and gets no nonce",
  directive(out, "script-src").includes("'unsafe-inline'") && !directive(out, "script-src").includes(TOKEN),
);

out = injectNonceIntoCsp("default-src 'self'; style-src 'self' 'unsafe-inline'", NONCE);
check(
  "explicit unsafe-inline style-src keeps unsafe-inline and gets no nonce",
  directive(out, "style-src").includes("'unsafe-inline'") && !directive(out, "style-src").includes(TOKEN),
);

out = injectNonceIntoCsp("default-src 'self' 'unsafe-inline'", NONCE);
check(
  "unsafe-inline default-src does not spawn a nonced directive",
  !out.includes(TOKEN) && directive(out, "script-src") === "" && directive(out, "style-src") === "",
);

out = injectNonceIntoCsp("default-src 'self'; script-src 'self' 'unsafe-inline'", NONCE);
check(
  "mixed unsafe-inline script but strict style nonces only style",
  !directive(out, "script-src").includes(TOKEN) && directive(out, "style-src").includes(TOKEN),
);

out = injectNonceIntoCsp("default-src 'self'", NONCE);
check(
  "strict default policy still gets the nonce",
  directive(out, "script-src").includes(TOKEN) && directive(out, "style-src").includes(TOKEN),
);

out = injectNonceIntoCsp("default-src 'self'; script-src 'self' https://cdn.example", NONCE);
check("explicit non-unsafe-inline directive still gets the nonce", directive(out, "script-src").includes(TOKEN));

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
