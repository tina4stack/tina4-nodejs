/**
 * Unit tests for the ScssCompiler module.
 * Run with: npx tsx test/scss.test.ts
 */
import { ScssCompiler } from "../packages/core/src/index.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
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

// Cleanup
rmSync(SCSS_DIR, { recursive: true });

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
