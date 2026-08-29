/**
 * The MSSQL adapter wires `booleanToInt` into `translateSql`, so a bare
 * TRUE/FALSE reaches BIT-backed SQL Server as 1/0. A TRUE/FALSE inside a string
 * literal is data and must survive untouched.
 *
 * No mocks: `translateSql` is a pure function over its input and the adapter
 * constructor opens no connection. Regression guard for the wiring gap where
 * mssql `translateSql` applied autoIncrementSyntax + ddlTypes but never
 * booleanToInt (firebird already did). Mirrors
 * tina4-python/tests/test_mssql_boolean_to_int_wiring.py.
 */
import { MssqlAdapter, FirebirdAdapter } from "../packages/orm/src/index.ts";

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const mssql = (sql: string): string =>
  new MssqlAdapter("mssql://localhost:1433/x").translateSql(sql);
const firebird = (sql: string): string =>
  new FirebirdAdapter("firebird://localhost:3050/x.fdb").translateSql(sql);

console.log("--- mssql booleanToInt wiring ---");
{
  const ins = mssql("INSERT INTO flags (active) VALUES (TRUE)");
  ok("mssql: bare TRUE becomes 1", ins.includes("(1)") && !/TRUE/i.test(ins), ins);
  const upd = mssql("UPDATE flags SET active = FALSE");
  ok("mssql: bare FALSE becomes 0", /=\s*0/.test(upd), upd);
  const lit = mssql("SELECT id FROM flags WHERE label = 'TRUE'");
  ok("mssql: 'TRUE' string literal is preserved", lit.includes("'TRUE'"), lit);
}

console.log("--- firebird booleanToInt wiring (parity guard) ---");
{
  const ins = firebird("INSERT INTO flags (active) VALUES (TRUE)");
  ok("firebird: bare TRUE becomes 1", ins.includes("(1)") && !/TRUE/i.test(ins), ins);
  const lit = firebird("SELECT id FROM flags WHERE label = 'TRUE'");
  ok("firebird: 'TRUE' string literal is preserved", lit.includes("'TRUE'"), lit);
}

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
