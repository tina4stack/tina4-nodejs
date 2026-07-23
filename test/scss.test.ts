/**
 * Unit tests for the ScssCompiler module.
 * Run with: npx tsx test/scss.test.ts
 */
import { ScssCompiler } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const SCSS_DIR = "/tmp/tina4-scss-test";
let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

// Clean slate
try { rmSync(SCSS_DIR, { recursive: true }); } catch {}
mkdirSync(SCSS_DIR, { recursive: true });

console.log("=== SCSS Compiler Tests ===\n");

const compiler = new ScssCompiler();

// --- Variables ---
console.log("--- Variables ---");

const varResult = compiler.compile(`
$color: #333;
$size: 16px;

body {
  color: $color;
  font-size: $size;
}
`);
assert("Variable substitution for color",
  varResult.includes("color: #333;"));
assert("Variable substitution for size",
  varResult.includes("font-size: 16px;"));

// --- Nesting ---
console.log("\n--- Nesting ---");

const nestResult = compiler.compile(`
.parent {
  color: red;
  .child {
    color: blue;
  }
}
`);
assert("Parent selector emitted",
  nestResult.includes(".parent {"));
assert("Nested child flattened",
  nestResult.includes(".parent .child {"));

// --- & Parent Selector ---
console.log("\n--- & Parent Selector ---");

const ampResult = compiler.compile(`
.btn {
  color: blue;
  &:hover {
    color: red;
  }
  &.active {
    color: green;
  }
}
`);
assert("& resolves :hover correctly",
  ampResult.includes(".btn:hover {"));
assert("& resolves .active correctly",
  ampResult.includes(".btn.active {"));

// --- Comments ---
console.log("\n--- Comments ---");

const commentResult = compiler.compile(`
// This is a single line comment
body {
  /* This is a block comment */
  color: black;
}
`);
assert("Single-line comments stripped",
  !commentResult.includes("single line comment"));
assert("Block comments preserved",
  commentResult.includes("/* This is a block comment */"));

// --- Basic Math ---
console.log("\n--- Basic Math ---");

const mathResult = compiler.compile(`
.box {
  width: 100px + 50px;
  height: 200px - 50px;
  margin: 10px * 2;
  padding: 100px / 4;
}
`);
assert("Addition: 100px + 50px = 150px",
  mathResult.includes("150px"));
assert("Subtraction: 200px - 50px = 150px",
  mathResult.includes("150px"));
assert("Multiplication: 10px * 2 = 20px",
  mathResult.includes("20px"));
assert("Division: 100px / 4 = 25px",
  mathResult.includes("25px"));

// --- Mixed-unit arithmetic — regression for tina4-nodejs#1 ---
//
// Before the fix, the evaluator extracted the unit from the first operand
// only and dropped the second's, silently producing wrong CSS:
//   100vh - 170px → -70vh (negative, layout-breaking)
//   100% - 20px   → 80%
// After the fix, mixed-unit expressions are left verbatim so the browser
// computes them — that is exactly what calc() is for.
console.log("\n--- Mixed-unit arithmetic (calc regression) ---");

const calcVh = compiler.compile(`.box { max-height: 100vh - 170px; }`);
assert("Mixed-unit vh-px outside calc: 100vh preserved",
  calcVh.includes("100vh") && calcVh.includes("170px"));
assert("Mixed-unit vh-px outside calc: NOT folded to -70vh",
  !calcVh.includes("-70vh"));

const calcPct = compiler.compile(`.box { width: 100% - 20px; }`);
assert("Mixed-unit %-px outside calc: source preserved",
  calcPct.includes("100%") && calcPct.includes("20px"));
assert("Mixed-unit %-px outside calc: NOT folded to 80%",
  !calcPct.includes("80%"));

const calcInside = compiler.compile(`.box { max-height: calc(100vh - 170px); }`);
assert("calc(100vh - 170px) preserved verbatim",
  calcInside.includes("calc(100vh - 170px)"));

const calcInsidePct = compiler.compile(`.box { width: calc(50% + 10px); }`);
assert("calc(50% + 10px) preserved verbatim",
  calcInsidePct.includes("calc(50% + 10px)"));

const sameUnit = compiler.compile(`.box { width: 10px + 5px; padding: 1rem + 2rem; }`);
assert("Same-unit addition still folds (10px + 5px = 15px)",
  sameUnit.includes("15px"));
assert("Same-unit rem addition still folds (1rem + 2rem = 3rem)",
  sameUnit.includes("3rem"));

const unitlessMul = compiler.compile(`.box { width: 2 * 5px; }`);
assert("Unitless multiplication still folds (2 * 5px = 10px)",
  unitlessMul.includes("10px"));

const unitlessDiv = compiler.compile(`.box { width: 10px / 2; }`);
assert("Unitless division still folds (10px / 2 = 5px)",
  unitlessDiv.includes("5px"));

// Color functions (issue #124) — rgba(<hex>,a) is invalid CSS; must expand.
console.log("\n--- Color functions (issue #124) ---");
const rgbaHex = compiler.compile(`$c: #0f3460; .box { box-shadow: 0 0 4px rgba($c, 0.12); }`);
assert("rgba(<hex>, a) becomes valid rgba(r, g, b, a)", rgbaHex.includes("rgba(15, 52, 96, 0.12)"));
assert("rgba(<hex>, a): no leftover rgba(#", !rgbaHex.includes("rgba(#"));

const rgbaNum = compiler.compile(`.box { color: rgba(10, 20, 30, 0.4); }`);
assert("numeric rgba(r, g, b, a) left untouched", rgbaNum.includes("rgba(10, 20, 30, 0.4)"));

const rgbHex = compiler.compile(`.box { color: rgb(#ffffff); }`);
assert("rgb(<hex>) becomes rgb(r, g, b)", rgbHex.includes("rgb(255, 255, 255)"));

const mixed = compiler.compile(`.box { background: mix(#ffffff, #000000, 50%); }`);
assert("mix() evaluates to a hex (#808080)", mixed.includes("#808080") && !mixed.includes("mix("));

const lightDark = compiler.compile(`.box { color: lighten(#0f3460, 20%); border-color: darken(#336699, 10%); }`);
assert("lighten/darken byte-identical to Python master",
  lightDark.includes("#1c63b8") && lightDark.includes("#264c72"));
assert("lighten/darken: no leftover function calls",
  !lightDark.includes("lighten(") && !lightDark.includes("darken("));

// --- Mixins ---
console.log("\n--- Mixins ---");

const mixinResult = compiler.compile(`
@mixin border-radius($radius) {
  -webkit-border-radius: $radius;
  border-radius: $radius;
}

.card {
  @include border-radius(5px);
  color: black;
}
`);
assert("Mixin @include substitutes parameter",
  mixinResult.includes("border-radius: 5px;"));
assert("Mixin expands webkit prefix",
  mixinResult.includes("-webkit-border-radius: 5px;"));

// --- @import ---
console.log("\n--- @import ---");

writeFileSync(join(SCSS_DIR, "_variables.scss"), "$primary: #007bff;\n");
writeFileSync(join(SCSS_DIR, "main.scss"), `
@import "variables";

.header {
  background: $primary;
}
`);

const importCompiler = new ScssCompiler({ importPaths: [SCSS_DIR] });
const importResult = importCompiler.compileFile(join(SCSS_DIR, "main.scss"));
assert("@import resolves partial and substitutes variable",
  importResult.includes("background: #007bff;"));

// --- setVariable ---
console.log("\n--- setVariable ---");

const varCompiler = new ScssCompiler();
varCompiler.setVariable("$theme-color", "#ff6600");
const setVarResult = varCompiler.compile(`
.header {
  color: $theme-color;
}
`);
assert("setVariable injects variable before compilation",
  setVarResult.includes("color: #ff6600;"));

// --- @media nesting ---
console.log("\n--- @media Nesting ---");

const mediaResult = compiler.compile(`
.container {
  width: 100%;

  @media (min-width: 768px) {
    width: 750px;
  }
}
`);
assert("@media block emitted correctly",
  mediaResult.includes("@media (min-width: 768px)"));
assert("@media contains flattened selector",
  mediaResult.includes(".container") && mediaResult.includes("750px"));

// --- Empty rules removed ---
console.log("\n--- Cleanup ---");

const emptyResult = compiler.compile(`
.empty {
}
.visible {
  color: red;
}
`);
assert("Empty rulesets removed",
  !emptyResult.includes(".empty") && emptyResult.includes(".visible"));

// --- #{ } interpolation (issue #116) ---
console.log("\n--- #{} interpolation ---");

{
  const r = compiler.compile(`$gap: 20px;\n.box { width: calc(100% - #{$gap}); }`);
  assert("variable interpolation inside calc()", r.includes("calc(100% - 20px)"), r);
  assert("no #{ } or $var left behind", !r.includes("#{") && !r.includes("$gap"), r);
}
{
  const r = compiler.compile(`$name: home;\n.icon-#{$name} { color: red; }`);
  assert("interpolation in selector", r.includes(".icon-home"), r);
}
{
  const r = compiler.compile(`.x { margin: #{10px}; }`);
  assert("literal interpolation inlines verbatim", r.includes("margin: 10px"), r);
}
{
  // Regression guard for the already-fixed half: mixed-unit calc preserved.
  const r = compiler.compile(`.z { height: calc(100vh - 170px); }`);
  assert("mixed-unit calc() still preserved", r.includes("calc(100vh - 170px)"), r);
}

// --- !default flag ---
// The `!default` flag means "assign only if this variable is not already set".
// It is a compiler directive and must never reach the CSS: `padding: 1.5rem
// !default` is invalid CSS and browsers drop the whole declaration. Reference
// behaviour for every case below was measured against Dart Sass 1.101.6.
console.log("\n--- !default flag ---");
{
  const r = compiler.compile("$g: 1.5rem !default;\n.x { padding: $g; }");
  assert("!default never reaches the output",
    r.includes("padding: 1.5rem") && !r.includes("!default"), r);
}
{
  // The themeing contract: a user sets $primary BEFORE the partial that declares
  // it !default, and must keep their value.
  const r = compiler.compile("$primary: red;\n$primary: blue !default;\n.y { color: $primary; }");
  assert("!default does not overwrite an already-set variable",
    r.includes("color: red") && !r.includes("blue") && !r.includes("!default"), r);
}
{
  const r = compiler.compile("$primary: blue !default;\n.y { color: $primary; }");
  assert("!default does assign an unset variable",
    r.includes("color: blue") && !r.includes("!default"), r);
}
{
  // Sass treats a null variable as unset, so !default fills it.
  const r = compiler.compile("$c: null;\n$c: teal !default;\n.w { color: $c; }");
  assert("null counts as unset", r.includes("color: teal") && !r.includes("null"), r);
}
{
  const r = compiler.compile("$a: 1rem !default;\n$a: 2rem !default;\n.v { margin: $a; }");
  assert("first !default wins over a second !default",
    r.includes("margin: 1rem") && !r.includes("2rem"), r);
}
{
  // !default only guards against being overwritten; a plain assignment wins.
  const r = compiler.compile("$a: 1rem !default;\n$a: 2rem;\n.v { margin: $a; }");
  assert("plain declaration after !default does overwrite", r.includes("margin: 2rem"), r);
}
{
  const r = compiler.compile("$a: 5px !default !global;\n.i { top: $a; }");
  assert("!global flag is also consumed",
    r.includes("top: 5px") && !r.includes("!default") && !r.includes("!global"), r);
}
{
  // A map literal spanning lines with the flag on the closing line — the exact
  // shape tina4-css's _variables.scss uses.
  const r = compiler.compile('$m: (\n  "a": 1,\n  "b": 2\n) !default;\n.m { z-index: 1; }');
  assert("multi-line !default declaration is consumed",
    !r.includes("!default") && !r.includes("$m"), r);
}
{
  // NEGATIVE guard on the strip's scope: only a *variable declaration* value is
  // stripped. Dart Sass keeps this string verbatim; so must we.
  const r = compiler.compile('.s { content: "x !default y"; }');
  assert("literal !default inside a quoted string is preserved",
    r.includes('"x !default y"'), r);
}
{
  // NEGATIVE guard: `rgba(#000 !default, .1)` is a syntax error in Dart Sass and
  // never appears in valid SCSS. We do not silently "fix" it into something Sass
  // would never emit — it is not a variable declaration, so it is left exactly
  // as written and stays visibly wrong.
  const r = compiler.compile(".z { color: rgba(#000 !default, 0.1); }");
  assert("!default in a function argument is left verbatim", r.includes("!default"), r);
}
{
  // The real-world case behind the 41 broken rgba() calls: the flag rode inside
  // the stored value and corrupted every function call using it.
  const r = compiler.compile("$black: #000 !default;\n.z { box-shadow: 0 1px 2px rgba($black, 0.075); }");
  assert("a !default hex variable is usable inside rgba()",
    r.includes("rgba(0, 0, 0, 0.075)") && !r.includes("!default"), r);
}
{
  // End-to-end over REAL files: set the variable, then @import a partial that
  // declares it !default. The override must win.
  const dir = join(SCSS_DIR, "defaults");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_theme.scss"), "$primary: navy !default;\n$accent: gold !default;\n");
  writeFileSync(join(dir, "main.scss"),
    '$primary: hotpink;\n@import "theme";\n.k { color: $primary; border-color: $accent; }\n');
  const r = new ScssCompiler().compileFile(join(dir, "main.scss"));
  assert("override survives an @import of a real partial",
    r.includes("color: hotpink") && r.includes("border-color: gold")
      && !r.includes("navy") && !r.includes("!default"), r);
}
{
  const c = new ScssCompiler();
  c.setVariable("primary", "rebeccapurple");
  const r = c.compile("$primary: navy !default;\n.p { color: $primary; }");
  assert("a preset variable beats a source !default",
    r.includes("color: rebeccapurple") && !r.includes("navy"), r);
}
{
  // compileScss over a real directory, writing a real file.
  const dir = join(SCSS_DIR, "dirdefault");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_vars.scss"), "$gap: 4px !default;\n");
  writeFileSync(join(dir, "app.scss"), '@import "vars";\n.a { margin: $gap; }\n');
  const out = join(dir, "out", "default.css");
  const r = new ScssCompiler().compileScss(dir, out);
  assert("compileScss over a directory strips the flag",
    r.includes("margin: 4px") && !r.includes("!default")
      && !readFileSync(out, "utf-8").includes("!default"), r);
}

// Cleanup
rmSync(SCSS_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
