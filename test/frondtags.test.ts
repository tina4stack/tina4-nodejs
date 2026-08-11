/**
 * Feature 53 - Frond {% include %} / {% extends %} path confinement (TAG-DEC-01).
 * Run with: npx tsx test/frondtags.test.ts
 *
 * Real templates on disk, a real secret file OUTSIDE the templates dir, and a
 * real symlink -- NO mocks. Every case drives the REAL Frond engine against
 * files it wrote to a temp directory. A legit include/extends UNDER the
 * templates dir renders; a `..` traversal, an absolute path, and a symlink whose
 * realpath escapes the templates dir are all REFUSED (a clear error, never the
 * outside file's bytes).
 *
 * Mutation proof: drop the containment guard in Frond#load (packages/frond/src/
 * engine.ts) and the traversal / absolute / symlink cases RENDER the outside
 * file's SECRET marker instead of throwing -- these assertions then go RED.
 *
 * Shared conformance fixture:
 * tina4-documentation/plan/v3/fixtures/frondtags_contract.json
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Frond } from "../packages/frond/src/engine.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

/** A marker written only to a file OUTSIDE the templates dir. */
const SECRET = "TOP-SECRET-OUTSIDE-9f83c1";

/** Build a REAL templates dir (legit partial + base) and a REAL secret OUTSIDE it. */
function makeTree(): { base: string; templates: string; secret: string } {
  const base = mkdtempSync(join(tmpdir(), "frondtags_node_"));
  const templates = join(base, "templates");
  mkdirSync(join(templates, "partials"), { recursive: true });
  writeFileSync(join(templates, "partials", "hello.twig"), "Hello from a real partial");
  writeFileSync(join(templates, "base.twig"), "[BASE {% block body %}default{% endblock %} END]");
  const secret = join(base, "secret.txt"); // lives OUTSIDE templates/
  writeFileSync(secret, SECRET);
  return { base, templates, secret };
}

/** Render must THROW (refused) with an "escape" message, and never leak SECRET. */
function assertRefused(templates: string, template: string): void {
  let threw = false;
  let out = "";
  let msg = "";
  try {
    out = new Frond(templates).render(template);
  } catch (err) {
    threw = true;
    msg = String((err as Error).message);
  }
  const ok = threw && /escape/i.test(msg) && !out.includes(SECRET) && !msg.includes(SECRET);
  assert(
    labelFor(template),
    ok,
    `threw=${threw} msg=${JSON.stringify(msg)} out=${JSON.stringify(out.slice(0, 40))}`,
  );
}

/** Map an evil template file to its canonical shared-fixture case name. */
function labelFor(template: string): string {
  if (template.includes("abs")) return "an absolute path include is refused";
  if (template.includes("link")) return "a symlink escaping the templates dir is refused";
  return "a dot dot traversal include is refused";
}

// --- a legit include renders under the templates dir ---
{
  const { base, templates } = makeTree();
  try {
    writeFileSync(join(templates, "page.twig"), 'X {% include "partials/hello.twig" %} Y');
    const out = new Frond(templates).render("page.twig");
    assert(
      "a legit include renders under the templates dir",
      out.includes("Hello from a real partial"),
      out,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- a legit extends renders under the templates dir ---
{
  const { base, templates } = makeTree();
  try {
    writeFileSync(
      join(templates, "child.twig"),
      '{% extends "base.twig" %}{% block body %}CHILD-BODY{% endblock %}',
    );
    const out = new Frond(templates).render("child.twig");
    assert(
      "a legit extends renders under the templates dir",
      out.includes("CHILD-BODY") && out.includes("BASE"),
      out,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- a dot dot traversal include is refused ---
{
  const { base, templates } = makeTree();
  try {
    writeFileSync(join(templates, "evil.twig"), '{% include "../secret.txt" %}');
    assertRefused(templates, "evil.twig");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- an absolute path include is refused ---
{
  const { base, templates, secret } = makeTree();
  try {
    writeFileSync(join(templates, "evil_abs.twig"), `{% include "${secret}" %}`);
    assertRefused(templates, "evil_abs.twig");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// --- a symlink escaping the templates dir is refused ---
{
  const { base, templates, secret } = makeTree();
  try {
    // A REAL symlink INSIDE the templates dir whose target is the secret OUTSIDE
    // it. Its name has no `..` and is not absolute, so only the realpath
    // containment can catch it.
    symlinkSync(secret, join(templates, "sneaky.twig"));
    writeFileSync(join(templates, "evil_link.twig"), '{% include "sneaky.twig" %}');
    assertRefused(templates, "evil_link.twig");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
