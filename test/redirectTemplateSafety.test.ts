/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

// errors/302.twig puts redirect_url into both an <a href> and a
// <meta http-equiv="refresh"> url. A tainted value must not be able to run
// script (javascript:/data:/vbscript:) or bounce the user off-site via a
// scheme-relative //host target. The template collapses anything that is not a
// same-site relative path or an explicit http/https URL to "/".
//
// Real Frond render against the shipped framework template — NO MOCKS. Case
// names match the sibling regression in tina4-php/tests/RedirectTemplateSafetyTest.php.
//
// Run with: npx tsx test/redirectTemplateSafety.test.ts
import { Frond } from "../packages/frond/src/engine.ts";

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

const frond = new Frond("packages/core/templates");

function renderedUrls(redirectUrl: string): { href: string; meta: string } {
  const html = frond.render("errors/302.twig", { redirect_url: redirectUrl, title: "t" });
  const href = (html.match(/<a href="([^"]*)"/) || [])[1] ?? "";
  const meta = (html.match(/url=([^"]*)">/) || [])[1] ?? "";
  return { href, meta };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

console.log("=== errors/302.twig redirect safety ===\n");

const dangerous = [
  "javascript:alert(1)",
  "JAVASCRIPT:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "//evil.example.com/pwn",
  "",
  "evilsite",
];
for (const url of dangerous) {
  const { href, meta } = renderedUrls(url);
  assert(`neutralises dangerous redirect ${JSON.stringify(url)}`, href === "/" && meta === "/", `href=${href} meta=${meta}`);
}

const safe: Array<[string, string]> = [
  ["/dashboard?x=1", "/dashboard?x=1"],
  ["/", "/"],
  ["https://tina4.com/ok", "https://tina4.com/ok"],
  ["http://tina4.com/ok", "http://tina4.com/ok"],
];
for (const [url, expected] of safe) {
  const e = escapeHtml(expected);
  const { href, meta } = renderedUrls(url);
  assert(`preserves safe redirect ${JSON.stringify(url)}`, href === e && meta === e, `href=${href} meta=${meta}`);
}

{
  const { href } = renderedUrls('/search?q="><img src=x onerror=alert(1)>');
  assert("escapes metacharacters in a relative path (no break-out)",
    href.startsWith("/search?q=") && !href.includes("<img") && !href.includes('"') && href.includes("&quot;"),
    `href=${href}`);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
