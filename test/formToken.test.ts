/**
 * Unit tests for form_token / formToken template function.
 * Run with: npx tsx test/formToken.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";
import { mkdirSync, rmSync } from "node:fs";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean) {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error(`Expected 3 parts, got ${parts.length}`);
  for (const p of parts) {
    if (p.length === 0) throw new Error("Empty JWT segment");
  }

  let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (b64.length % 4);
  if (pad !== 4) b64 += "=".repeat(pad);
  return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
}

function extractToken(html: string): string {
  const prefix = '<input type="hidden" name="formToken" value="';
  const start = html.indexOf(prefix);
  if (start === -1) throw new Error(`Expected hidden input, got: ${html}`);
  const valueStart = start + prefix.length;
  const end = html.indexOf('"', valueStart);
  return html.slice(valueStart, end);
}

// Set up
process.env.SECRET = "test-secret-key";
const tmpDir = "/tmp/frond-formtoken-test";
try { rmSync(tmpDir, { recursive: true }); } catch {}
mkdirSync(tmpDir, { recursive: true });

const engine = new Frond(tmpDir);

console.log("=== form_token / formToken Tests ===\n");

// ── Global function tests ──

console.log("Global function:");

{
  const output = engine.renderString("{{ form_token() }}");
  assert("renders hidden input element",
    output.includes('<input type="hidden" name="formToken" value="'));
  assert("ends with \">",
    output.trim().endsWith('">'));
}

{
  const output = engine.renderString("{{ form_token() }}");
  assert("not HTML-escaped (no &lt;)",
    !output.includes("&lt;"));
  assert("not HTML-escaped (no &gt;)",
    !output.includes("&gt;"));
}

{
  const output = engine.renderString("{{ form_token() }}");
  const token = extractToken(output);
  const parts = token.split(".");
  assert("token has 3 dot-separated parts", parts.length === 3);
  const payload = decodeJwtPayload(token);
  assert("basic payload type is form", payload.type === "form");
}

{
  const output = engine.renderString("{{ form_token() }}");
  const token = extractToken(output);
  const payload = decodeJwtPayload(token);
  assert("no context in basic payload", !("context" in payload));
  assert("no ref in basic payload", !("ref" in payload));
}

{
  const output = engine.renderString('{{ form_token("my_context") }}');
  const token = extractToken(output);
  const payload = decodeJwtPayload(token);
  assert("context-only: type is form", payload.type === "form");
  assert("context-only: context is my_context", payload.context === "my_context");
  assert("context-only: no ref", !("ref" in payload));
}

{
  const output = engine.renderString('{{ form_token("checkout|order_123") }}');
  const token = extractToken(output);
  const payload = decodeJwtPayload(token);
  assert("context+ref: type is form", payload.type === "form");
  assert("context+ref: context is checkout", payload.context === "checkout");
  assert("context+ref: ref is order_123", payload.ref === "order_123");
}

// ── formToken alias ──

console.log("\nformToken alias:");

{
  const output = engine.renderString("{{ formToken() }}");
  assert("formToken() renders hidden input",
    output.includes('<input type="hidden" name="formToken" value="'));
}

// ── Filter tests ──

console.log("\nFilter:");

{
  const output = engine.renderString('{{ "admin" | form_token }}');
  assert("filter renders hidden input",
    output.includes('<input type="hidden" name="formToken" value="'));
  const token = extractToken(output);
  const payload = decodeJwtPayload(token);
  assert("filter context is admin", payload.context === "admin");
}

{
  const output = engine.renderString('{{ "checkout|order_123" | form_token }}');
  const token = extractToken(output);
  const payload = decodeJwtPayload(token);
  assert("filter pipe descriptor: context is checkout", payload.context === "checkout");
  assert("filter pipe descriptor: ref is order_123", payload.ref === "order_123");
}

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
