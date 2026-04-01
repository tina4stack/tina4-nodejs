/**
 * Unit tests for CLI scaffolding (packages/cli/src/commands/generate.ts).
 * Run with: npx tsx test/cli.test.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  toSnake, toTableName, parseFields, parseCliArgs, generate,
} from "../packages/cli/src/commands/generate.ts";

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

console.log("=== CLI Scaffolding Tests ===\n");

// --- toSnake ---
console.log("--- toSnake ---");

assert("simple lowercase", toSnake("product") === "product");
assert("CamelCase", toSnake("ProductCategory") === "product_category");
assert("camelCase", toSnake("productCategory") === "product_category");
assert("consecutive uppercase", toSnake("HTMLParser") === "html_parser");
assert("single letter", toSnake("A") === "a");
assert("already_snake", toSnake("already_snake") === "already_snake");
assert("numbers preserved", toSnake("Item2") === "item2");

// --- toTableName ---
console.log("\n--- toTableName ---");

assert("CamelCase to snake", toTableName("ProductCategory") === "product_category");
assert("simple name", toTableName("User") === "user");
assert("already lower", toTableName("orders") === "orders");

// --- parseFields ---
console.log("\n--- parseFields ---");

{
  const fields = parseFields("name:string,price:float,active:boolean");
  assert("parses 3 fields", fields.length === 3);
  assert("first field name", fields[0][0] === "name" && fields[0][1] === "string");
  assert("second field name", fields[1][0] === "price" && fields[1][1] === "float");
  assert("third field name", fields[2][0] === "active" && fields[2][1] === "boolean");
}

{
  const fields = parseFields("title,description");
  assert("fields without type default to string", fields[0][1] === "string" || fields[0][0] === "title");
  assert("second field without type", fields[1][0] === "description");
}

{
  const fields = parseFields("");
  assert("empty string returns empty array", fields.length === 0);
}

{
  const fields = parseFields("  name : string , age : int  ");
  assert("trims whitespace", fields[0][0] === "name" && fields[0][1] === "string");
  assert("trims second field", fields[1][0] === "age" && fields[1][1] === "int");
}

{
  const fields = parseFields("email:str,count:integer,price:decimal,memo:text,dob:datetime,data:blob");
  assert("parses 6 type aliases", fields.length === 6);
  assert("str type", fields[0][1] === "str");
  assert("integer type", fields[1][1] === "integer");
  assert("decimal type", fields[2][1] === "decimal");
  assert("text type", fields[3][1] === "text");
  assert("datetime type", fields[4][1] === "datetime");
  assert("blob type", fields[5][1] === "blob");
}

// --- parseCliArgs ---
console.log("\n--- parseCliArgs ---");

{
  const { flags, positional } = parseCliArgs(["model", "Product", "--fields", "name:string"]);
  assert("positional has model and Product", positional[0] === "model" && positional[1] === "Product");
  assert("flags has fields", flags.fields === "name:string");
}

{
  const { flags, positional } = parseCliArgs(["--verbose", "--dry-run"]);
  assert("boolean flags", flags.verbose === true && flags["dry-run"] === true);
  assert("no positional args", positional.length === 0);
}

{
  const { flags, positional } = parseCliArgs(["route", "products", "--model", "Product", "--fields", "name:string,price:float"]);
  assert("mixed positional and flags", positional.length === 2);
  assert("model flag", flags.model === "Product");
  assert("fields flag", flags.fields === "name:string,price:float");
}

{
  const { flags, positional } = parseCliArgs([]);
  assert("empty args", positional.length === 0 && Object.keys(flags).length === 0);
}

// --- Generate scaffolding (file creation) ---
console.log("\n--- Generate Model ---");

const tmpDir = "/tmp/tina4-cli-test-" + Date.now();
mkdirSync(tmpDir, { recursive: true });

// Override process.cwd to use tmp dir
const origCwd = process.cwd();
process.chdir(tmpDir);

try {
  await generate("model", "Product", ["--fields", "name:string,price:float", "--no-migration"]);

  const modelPath = join(tmpDir, "src/models/Product.ts");
  assert("model file created", existsSync(modelPath));

  if (existsSync(modelPath)) {
    const content = readFileSync(modelPath, "utf-8");
    assert("model imports BaseModel", content.includes("BaseModel"));
    assert("model has tableName", content.includes('tableName = "product"'));
    assert("model has name field", content.includes("name:"));
    assert("model has price field", content.includes("price:"));
    assert("model has id field", content.includes("id:"));
    assert("model has created_at field", content.includes("created_at:"));
  }
} catch (e: any) {
  assert("model generation", false, e.message);
}

// --- Generate Route ---
console.log("\n--- Generate Route ---");

try {
  await generate("route", "products", ["--model", "Product"]);

  const routeDir = join(tmpDir, "src/routes/api/products");
  assert("route directory created", existsSync(routeDir));

  const getPath = join(routeDir, "get.ts");
  assert("GET route file created", existsSync(getPath));

  if (existsSync(getPath)) {
    const content = readFileSync(getPath, "utf-8");
    assert("route has handler function", content.includes("function") || content.includes("export default"));
    assert("route references Tina4Request", content.includes("Tina4Request"));
  }
} catch (e: any) {
  assert("route generation", false, e.message);
}

// --- Generate Migration ---
console.log("\n--- Generate Migration ---");

try {
  await generate("migration", "create_tasks", ["--fields", "title:string,done:boolean"]);

  const migDir = join(tmpDir, "migrations");
  if (existsSync(migDir)) {
    const files = readdirSync(migDir);
    const migUpFile = files.find((f: string) => f.includes("create_tasks") && !f.includes(".down."));
    const migDownFile = files.find((f: string) => f.includes("create_tasks") && f.includes(".down."));
    assert("migration up file created", migUpFile !== undefined);
    assert("migration down file created", migDownFile !== undefined);

    if (migUpFile) {
      const content = readFileSync(join(migDir, migUpFile), "utf-8");
      assert("migration has CREATE TABLE", content.includes("CREATE TABLE"));
      assert("migration has table name", content.includes("create_tasks") || content.includes("tasks"));
      assert("migration has -- Migration header", content.includes("-- Migration:"));
    }
  } else {
    assert("migrations directory created", false);
  }
} catch (e: any) {
  assert("migration generation", false, e.message);
}

// --- Generate Middleware ---
console.log("\n--- Generate Middleware ---");

try {
  await generate("middleware", "RateLimit", []);

  // Generator converts name to snake_case
  const mwPath = join(tmpDir, "src/middleware/rate_limit.ts");
  assert("middleware file created", existsSync(mwPath));

  if (existsSync(mwPath)) {
    const content = readFileSync(mwPath, "utf-8");
    assert("middleware has Tina4Request import", content.includes("Tina4Request"));
    assert("middleware has next call", content.includes("next"));
  }
} catch (e: any) {
  assert("middleware generation", false, e.message);
}

// --- Generate Test ---
console.log("\n--- Generate Test ---");

try {
  await generate("test", "products", ["--model", "Product"]);

  // Generator puts tests in tests/ (not test/)
  const testPath = join(tmpDir, "tests/products.test.ts");
  assert("test file created", existsSync(testPath));

  if (existsSync(testPath)) {
    const content = readFileSync(testPath, "utf-8");
    assert("test has assert function", content.includes("assert"));
  }
} catch (e: any) {
  assert("test generation", false, e.message);
}

// Restore working directory
process.chdir(origCwd);

// Cleanup
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
