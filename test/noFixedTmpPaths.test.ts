/**
 * Guard: no test may hard-code a shared scratch path under /tmp.
 *
 * Why this exists. On 2026-09-24 createTableCallableDefault, ormNullForUnset and
 * parityStaticOrm died on the shared lab with "attempt to write a readonly
 * database": a concurrent run as root had created /tmp/tina4-cd61-test,
 * /tmp/tina4-orm-null-unset-165 and /tmp/tina4-parity-static-orm, and the next
 * run as andre could neither remove nor write them. 48 test files carried a
 * fixed /tmp name. Each now takes a per-run directory:
 *
 *     const DIR = mkdtempSync(join(tmpdir(), "tina4-foo-"));
 *     ...
 *     rmSync(DIR, { recursive: true, force: true });
 *
 * which is unique per process, owned by whoever runs it, and honours TMPDIR (the
 * run-all.ts sandbox). This file fails the suite if a fixed path comes back.
 *
 * What counts as a violation, on any non-comment line of any file under test/:
 *   - "/tmp/..." inside a string or template literal (incl. sqlite:///tmp/...)
 *   - a bare "/tmp" literal, as in join("/tmp", "name")
 *   - tmpdir() joined with a CONSTANT name, as in join(tmpdir(), "name") --
 *     the same collision under another spelling. mkdtempSync(join(tmpdir(), ..))
 *     is the fix and is not flagged.
 *
 * Exceptions go in ALLOWED with a reason. An allow-list entry that no longer
 * matches anything fails too, so the list cannot rot into a blanket pass.
 *
 * Pure logic over the files on disk: no service, no double.
 * Run with: npx tsx test/noFixedTmpPaths.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, basename } from "node:path";

const TEST_ROOT = import.meta.dirname;
const SELF = basename(import.meta.filename);

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? `\n${detail}` : ""}`);
    fail++;
  }
}

/** A justified fixed /tmp mention: `needle` must appear on the flagged line. */
interface AllowedFixedPath {
  file: string;
  needle: string;
  reason: string;
}

const ALLOWED: AllowedFixedPath[] = [
  {
    file: "smoke.test.ts",
    needle: 'parseDatabaseUrl("sqlite:////tmp/test.db")',
    reason: "a URL-parser input; the string is parsed, nothing is opened or created",
  },
  {
    file: "smoke.test.ts",
    needle: 'sqliteUrl.database === "/tmp/test.db"',
    reason: "the parser's expected output for the input above; never touches the filesystem",
  },
  {
    file: "cacheKeyDatabaseIdentity.test.ts",
    needle: 'cacheIdentity("sqlite:///tmp/a.db")',
    reason: "pure cache-key derivation over a URL string; no database is opened",
  },
  {
    file: "cacheKeyDatabaseIdentity.test.ts",
    needle: 'cacheIdentity("sqlite:///tmp/b.db")',
    reason: "pure cache-key derivation over a URL string; no database is opened",
  },
  {
    file: "databaseConnectTimeout.test.ts",
    needle: 'database: "/tmp/tina4-connect-timeout-probe.fdb"',
    reason:
      "a Firebird database NAME sent over the wire to an in-test server that never replies; " +
      "it is never opened or created on this host",
  },
  {
    file: "mqttAuthTls.test.ts",
    needle: '(process.env.TMPDIR || "/tmp")',
    reason:
      "the documented default location test/mqtt-infra.sh writes the broker CA to " +
      "(${TMPDIR:-/tmp}/tina4-mqtt-infra); it must stay the SAME fixed path the infra " +
      "script uses, and the test only reads it",
  },
];

// ── detection ──

const LITERAL_TMP_PATH = /\/tmp\//;
const BARE_TMP_LITERAL = /["'`]\/tmp["'`]/;
// tmpdir() joined with a constant name, unless it is the mkdtempSync prefix
// (whatever the join helper is imported as: join, path.join, joinPath).
const TMPDIR_CONSTANT_NAME =
  /(?<!mkdtempSync\(\s*[\w.]+\(\s*(?:os\.)?)tmpdir\(\)\s*,\s*(["'])[^"'`$]*\1\s*\)/;

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function violates(line: string): boolean {
  if (isCommentLine(line)) return false;
  return LITERAL_TMP_PATH.test(line) || BARE_TMP_LITERAL.test(line) || TMPDIR_CONSTANT_NAME.test(line);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry) && entry !== SELF) {
      out.push(full);
    }
  }
  return out.sort();
}

console.log("=== No fixed /tmp scratch paths in test/ ===\n");

// ── the detector itself: must flag each bad shape and pass each good one ──
console.log("--- detector ---");
const mustFlag = [
  'const TEST_DIR = "/tmp/tina4-foo-test";',
  "const p = `/tmp/tina4_cache_${Date.now()}`;",
  'await initDatabase({ url: `sqlite:///tmp/x_${process.pid}.db` });',
  'const p = join("/tmp", "tina4-queue-" + Date.now());',
  "const d = join(os.tmpdir(), 'tina4-csp-warn-test');",
  'const d = path.join(tmpdir(), "fixed-name");',
];
const mustPass = [
  'const TEST_DIR = mkdtempSync(join(tmpdir(), "tina4-foo-test-"));',
  'const d = mkdtempSync(path.join(os.tmpdir(), "x-"));',
  'process.env.TINA4_QUEUE_PATH = mkdtempSync(joinPath(tmpdir(), "tina4-devadmin-queue-"));',
  "const d = join(tmpdir(), `tina4-run-${process.pid}`);",
  "// the lab exports TINA4_QUEUE_PATH=/tmp/tina4-queue-<fw>",
  " * 104 `/tmp/tina4-sessfail-*` directories had accumulated",
];
for (const line of mustFlag) assert(`flags: ${line}`, violates(line));
for (const line of mustPass) assert(`passes: ${line}`, !violates(line));

// ── the real tree ──
console.log("\n--- test/ tree ---");
const files = sourceFiles(TEST_ROOT);
assert("scans the test tree (found files to check)", files.length > 100, `only ${files.length} files found`);

const used = new Set<AllowedFixedPath>();
const violations: string[] = [];
for (const file of files) {
  const rel = relative(TEST_ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!violates(line)) return;
    const allowed = ALLOWED.find((a) => a.file === rel && line.includes(a.needle));
    if (allowed) {
      used.add(allowed);
      return;
    }
    violations.push(`    test/${rel}:${index + 1}: ${line.trim()}`);
  });
}

assert(
  "no test hard-codes a shared /tmp scratch path",
  violations.length === 0,
  violations.join("\n") +
    '\n    Use mkdtempSync(join(tmpdir(), "<name>-")) and rmSync(dir, { recursive: true, force: true }) in cleanup,' +
    "\n    or add an ALLOWED entry in test/noFixedTmpPaths.test.ts with the reason it is not a scratch path.",
);

const stale = ALLOWED.filter((a) => !used.has(a));
assert(
  "every allow-list entry still matches a line (no stale exceptions)",
  stale.length === 0,
  stale.map((a) => `    ${a.file}: ${a.needle}`).join("\n"),
);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
