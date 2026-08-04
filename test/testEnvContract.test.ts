/**
 * TEST-ENV CONTRACT - the canonical test-service variable set is the only set.
 *
 * Enforces test/fixtures/test_env_contract.json (ADR-0038), the shared fixture
 * carried byte-identical by all four frameworks. That file lists every legal
 * test-service variable name; this gate scans this framework's own suite plus
 * .github/workflows and FAILS, naming the offender and its file, on any name
 * that is not on the list.
 *
 * WHY. One test PostgreSQL had thirteen spellings and no two frameworks read
 * the same set - _URL vs _POSTGRES_URL, _USER vs _USERNAME, _PASS vs
 * _PASSWORD, _DB vs _DATABASE. Twice in one night a test skipped, someone
 * exported the single name that one framework happened to read, and more
 * previously-dead tests appeared. An allow-list with no single source of truth
 * rots by addition; adding a fourteenth spelling must turn a suite RED instead
 * of silently turning a test off.
 *
 * WORKFLOWS ARE SCANNED TOO, deliberately. A CI file that SETS a name no test
 * READS is the exact failure that hid 4 Node tests: the gate must catch a rogue
 * set, not just a rogue read.
 *
 * NOTHING HERE IS MOCKED. The scan reads the REAL fixture and the REAL files on
 * disk. The negative case runs the SAME checker over a synthetic source string,
 * so the reported-violation path is exercised by the same code the real scan
 * uses - not a parallel reimplementation that could drift green.
 *
 * Run with: npx tsx test/testEnvContract.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

/**
 * THIS FILE MAY NEVER WRITE A NON-CANONICAL NAME AS A QUOTED LITERAL. It sits
 * inside the scanned tree, so `const bogus = "<prefix>PG_FOO"` would be
 * quote-preceded, the scan below would find it in THIS file, and the gate would
 * fail on its own source. Assemble such names from this constant at runtime
 * instead. A canonical name in quotes is fine - that is why the guards below
 * can name TINA4_TEST_PG_URL directly.
 */
const VARIABLE_PREFIX = "TINA4" + "_TEST_";

/**
 * A name counts only where it is USED, never where it is merely described.
 *
 * The naive pattern (the prefix followed by [A-Z0-9_]*) also matches prose, and
 * on an untouched tree it FALSE-POSITIVED on three comments that legitimately
 * name the family as a glob - two here and one in the workflow. A gate that
 * reddens on a comment gets switched off, so a usage needs a lead context:
 *
 *   (a) a quote - covers process.env["X"], YAML/shell string values, and the
 *       dotenv test's writeFileSync(path, "X=yes\n")
 *   (b) `process.env.` - the dot form, which is the DOMINANT read in this repo;
 *       without this branch the scan would miss nearly every read and pass
 *       vacuously (the dot-form guard below pins that)
 *   (c) `export ` ANYWHERE on the line - NOT anchored to the line start
 *   (d) line start after optional whitespace - a YAML env key (`  X: value`)
 *       or a bare shell assignment
 *
 * (c) MUST NOT be anchored. test/mqtt-infra.sh:164-168 emits its coordinates as
 *     echo "export TINA4_TEST_MQTT_URL=mqtt://127.0.0.1:1883"
 * where `export` sits mid-line after `echo "`. An anchored form matches none of
 * those five MQTT names - a name that is SET and never READ, which is the
 * precise failure this gate exists to catch. All four frameworks ship the same
 * script and the same unanchored rule; Python is the reference.
 *
 * The trailing quantifier is `+`, not `*`: a bare prefix with nothing after it
 * is not a name and must never be reported.
 *
 * KNOWN NARROWING, measured on this tree and currently unused by it: a name
 * written mid-line with no quote, no dot and no `export` is not seen - an inline
 * env assignment in a `run:` step (`run: X=1 npx tsx ...`), a YAML inline flow
 * map (`env: { X: v }`), or a destructure (`const { X } = process.env`). Write
 * any of those in one of the four forms above.
 */
const TOKEN_PATTERN_SOURCE =
  "(?:['\"]|process\\.env\\.|export\\s+|^\\s*)(" + VARIABLE_PREFIX + "[A-Z0-9_]+)";

/** The fixture is the definition; its prose deliberately names retired spellings. */
const FIXTURE_RELATIVE_PATH = "test/fixtures/test_env_contract.json";
const FIXTURE_ABSOLUTE_PATH = path.join(REPO_ROOT, FIXTURE_RELATIVE_PATH);

/** Directories a source scan must never descend into. */
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

interface TestEnvContract {
  services: Record<string, string[]>;
  fixtures: string[];
  dynamic_prefixes: string[];
  scan_paths: Record<string, string[]>;
}

interface Violation {
  variableName: string;
  file: string;
}

/** How a name was reached. Tracked so the guards can prove each form is live. */
type UsageForm = "dot" | "quoted" | "export" | "line-start";

interface ScanHit {
  variableName: string;
  form: UsageForm;
}

/**
 * Every legal name: the prefix followed by <SERVICE>_<ATTRIBUTE> for each
 * service/attribute pair in the fixture, plus the test-owned fixture values
 * that carry no service grammar.
 */
function buildCanonicalNames(contract: TestEnvContract): Set<string> {
  const canonicalNames = new Set<string>();
  for (const [serviceName, attributes] of Object.entries(contract.services)) {
    for (const attribute of attributes) {
      canonicalNames.add(`${VARIABLE_PREFIX}${serviceName}_${attribute}`);
    }
  }
  for (const fixtureName of contract.fixtures) canonicalNames.add(fixtureName);
  return canonicalNames;
}

/**
 * THE CHECKER. One function, used by both the real scan and the negative case,
 * so a violation the synthetic source proves is reportable is the same violation
 * the real files would report.
 */
function findViolations(
  sourceText: string,
  fileLabel: string,
  canonicalNames: Set<string>,
  dynamicPrefixes: string[],
): { violations: Violation[]; hits: ScanHit[] } {
  const tokenPattern = new RegExp(TOKEN_PATTERN_SOURCE, "gm");
  const violations: Violation[] = [];
  const hits: ScanHit[] = [];
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(sourceText)) !== null) {
    const variableName = match[1];
    const lead = match[0].slice(0, match[0].length - variableName.length);
    const form: UsageForm = lead.includes("process.env.")
      ? "dot"
      : /['"]$/.test(lead)
        ? "quoted"
        : /export\s+$/.test(lead)
          ? "export"
          : "line-start";
    hits.push({ variableName, form });
    if (canonicalNames.has(variableName)) continue;
    if (dynamicPrefixes.includes(variableName)) continue;
    violations.push({ variableName, file: fileLabel });
  }
  return { violations, hits };
}

/** Every file under `directory`, skipping node_modules / dist / .git. */
function collectFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collected.push(...collectFiles(fullPath));
    else if (entry.isFile()) collected.push(fullPath);
  }
  return collected;
}

console.log("\n\x1b[1m=== Test-env contract (canonical variable set) ===\x1b[0m\n");

// ── The fixture loads and is the shape the gate depends on ─────────
const contract: TestEnvContract = JSON.parse(fs.readFileSync(FIXTURE_ABSOLUTE_PATH, "utf-8"));
assert("fixture loads and declares services", Object.keys(contract.services ?? {}).length > 0);
assert("fixture declares test-owned fixture names", Array.isArray(contract.fixtures) && contract.fixtures.length > 0);
assert("fixture declares nodejs scan paths", Array.isArray(contract.scan_paths?.nodejs) && contract.scan_paths.nodejs.length > 0);

const canonicalNames = buildCanonicalNames(contract);
const dynamicPrefixes = contract.dynamic_prefixes ?? [];
assert("canonical set is non-trivial", canonicalNames.size >= 40, `built ${canonicalNames.size}`);

// The two names the .env-loading test writes into temp .env files must be legal.
assert("TINA4_TEST_FROM_DEFAULT is canonical", canonicalNames.has("TINA4_TEST_FROM_DEFAULT"));
assert("TINA4_TEST_FROM_CUSTOM is canonical", canonicalNames.has("TINA4_TEST_FROM_CUSTOM"));

// ── Walk the declared scan paths ───────────────────────────────────
const scannedFiles: string[] = [];
for (const scanPath of contract.scan_paths.nodejs) {
  const absoluteScanPath = path.join(REPO_ROOT, scanPath);
  // A missing scan path is a broken gate, not a clean run.
  assert(`scan path exists: ${scanPath}`, fs.existsSync(absoluteScanPath), absoluteScanPath);
  if (!fs.existsSync(absoluteScanPath)) continue;
  scannedFiles.push(...collectFiles(absoluteScanPath));
}

const allViolations: Violation[] = [];
const allHits: ScanHit[] = [];
let filesRead = 0;

for (const absoluteFilePath of scannedFiles) {
  const relativeFilePath = path.relative(REPO_ROOT, absoluteFilePath);
  if (relativeFilePath === FIXTURE_RELATIVE_PATH) continue;
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(absoluteFilePath, "utf-8");
  } catch {
    continue;
  }
  filesRead++;
  const { violations, hits } = findViolations(sourceText, relativeFilePath, canonicalNames, dynamicPrefixes);
  allViolations.push(...violations);
  allHits.push(...hits);
}

// ── Guard against a vacuous pass ───────────────────────────────────
// A broken walk, or a lead-context branch that silently stopped matching,
// finds nothing and would otherwise report a clean green.
const distinctTokens = new Set(allHits.map((hit) => hit.variableName));
assert("scan read real files", filesRead >= 50, `read ${filesRead} files`);
assert("scan found a healthy number of occurrences", allHits.length >= 40, `found ${allHits.length}`);
assert("scan found a healthy number of distinct names", distinctTokens.size >= 40, `found ${distinctTokens.size}`);
for (const knownName of ["TINA4_TEST_PG_URL", "TINA4_TEST_PG_USERNAME"]) {
  assert(`scan saw known name ${knownName}`, distinctTokens.has(knownName), `distinct=${distinctTokens.size}`);
}

// Each lead-context branch must be LIVE on the real tree. The dot branch is the
// dominant read form here, so if it ever stopped matching the scan would still
// find the YAML keys and report a healthy-looking green over near-zero reads.
const dotFormNames = new Set(allHits.filter((hit) => hit.form === "dot").map((hit) => hit.variableName));
const quotedFormNames = new Set(allHits.filter((hit) => hit.form === "quoted").map((hit) => hit.variableName));
const lineStartNames = new Set(allHits.filter((hit) => hit.form === "line-start").map((hit) => hit.variableName));
assert(
  "process.env. DOT form is live (TINA4_TEST_PG_HOST)",
  dotFormNames.has("TINA4_TEST_PG_HOST"),
  `dot-form names seen: ${dotFormNames.size}`,
);
assert("dot form carries most of the reads", dotFormNames.size >= 20, `dot-form names seen: ${dotFormNames.size}`);
assert(
  "quoted form is live (TINA4_TEST_FROM_DEFAULT, written into a temp .env)",
  quotedFormNames.has("TINA4_TEST_FROM_DEFAULT"),
  `quoted names seen: ${quotedFormNames.size}`,
);
assert(
  "line-start form is live (YAML env keys)",
  lineStartNames.size >= 10,
  `line-start names seen: ${lineStartNames.size}`,
);

// The unanchored `export` branch, pinned against the real script that needs it.
// test/mqtt-infra.sh emits `echo "export <NAME>=..."` mid-line; an anchored
// branch sees none of these five, and a name SET but never READ is exactly what
// this gate exists to catch.
const exportFormNames = new Set(allHits.filter((hit) => hit.form === "export").map((hit) => hit.variableName));
const MQTT_NAMES_FROM_INFRA_SCRIPT = [
  "TINA4_TEST_MQTT_URL",
  "TINA4_TEST_MQTT_AUTH_URL",
  "TINA4_TEST_MQTT_TLS_URL",
  "TINA4_TEST_MQTT_EMQX_URL",
  "TINA4_TEST_MQTT_CA_FILE",
];
for (const mqttName of MQTT_NAMES_FROM_INFRA_SCRIPT) {
  assert(
    `echoed-export form is live: ${mqttName}`,
    exportFormNames.has(mqttName),
    `export-form names seen: ${[...exportFormNames].join(", ") || "NONE"}`,
  );
}

// ── THE GATE ───────────────────────────────────────────────────────
assert(
  "every scanned variable name is canonical",
  allViolations.length === 0,
  allViolations.length === 0
    ? ""
    : `${allViolations.length} non-canonical name(s):\n` +
      allViolations
        .map((violation) => `      ${violation.variableName}  in  ${violation.file}`)
        .join("\n") +
      `\n      Add the name to ${FIXTURE_RELATIVE_PATH} (in the right service) or use a canonical one.`,
);
if (allViolations.length > 0) {
  console.log("\n\x1b[31m  NON-CANONICAL TEST ENVIRONMENT VARIABLES:\x1b[0m");
  for (const violation of allViolations) {
    console.log(`\x1b[31m    ${violation.variableName}  in  ${violation.file}\x1b[0m`);
  }
  console.log("");
}

// ── NEGATIVE CASE ──────────────────────────────────────────────────
// The bogus name is assembled at runtime so the literal never appears in this
// file and cannot be picked up by the real scan above.
const bogusName = VARIABLE_PREFIX + "PG_FOO";
const syntheticSource = `const value = process.env.${bogusName} ?? "x";\nconst ok = process.env["TINA4_TEST_PG_URL"];\n`;
const negative = findViolations(syntheticSource, "synthetic.ts", canonicalNames, dynamicPrefixes);
assert(
  "a non-canonical name IS reported",
  negative.violations.length === 1 && negative.violations[0].variableName === bogusName,
  `got ${JSON.stringify(negative.violations)}`,
);
assert(
  "the violation names its file",
  negative.violations.length === 1 && negative.violations[0].file === "synthetic.ts",
  `got ${JSON.stringify(negative.violations)}`,
);
assert(
  "a canonical name alongside it is NOT reported",
  negative.hits.some((hit) => hit.variableName === "TINA4_TEST_PG_URL") &&
    !negative.violations.some((violation) => violation.variableName === "TINA4_TEST_PG_URL"),
);
// FORM COVERAGE. One case per real use site, each setting or reading the SAME
// off-list name a different way. Every one must be caught: a name is a name
// however it is spelled into the file, and a form the gate cannot see is a
// place drift can hide.
const formCases: [string, string][] = [
  ["double-quoted read", `process.env["${bogusName}"]`],
  ["single-quoted read", `process.env['${bogusName}']`],
  ["dot read", `const v = process.env.${bogusName};`],
  ["YAML env key", `      ${bogusName}: postgres://host/db\n`],
  ["line-start export", `export ${bogusName}=x\n`],
  ["ECHOED export (mid-line)", `echo "export ${bogusName}=x"\n`],
  ["echoed assignment into GITHUB_ENV", `echo "${bogusName}=$X" >> "$GITHUB_ENV"\n`],
];
for (const [label, formSource] of formCases) {
  const formResult = findViolations(formSource, "synthetic-form", canonicalNames, dynamicPrefixes);
  assert(
    `form is caught: ${label}`,
    formResult.violations.length === 1 && formResult.violations[0].variableName === bogusName,
    `violations=${JSON.stringify(formResult.violations)}`,
  );
}

// A global RegExp carries lastIndex between uses. The checker builds a fresh one
// per call for exactly this reason; if that ever changes, alternate invocations
// would silently skip matches and the gate would go quiet on half the tree.
const repeatSourceText = `process.env.${bogusName}\nprocess.env["${bogusName}"]\n`;
const firstRun = findViolations(repeatSourceText, "synthetic-repeat", canonicalNames, dynamicPrefixes);
const secondRun = findViolations(repeatSourceText, "synthetic-repeat", canonicalNames, dynamicPrefixes);
assert(
  "checker is stateless across calls (no lastIndex carry-over)",
  firstRun.violations.length === 2 && JSON.stringify(firstRun.violations) === JSON.stringify(secondRun.violations),
  `first=${JSON.stringify(firstRun.violations)} second=${JSON.stringify(secondRun.violations)}`,
);

// PROSE IS NOT A USAGE. These three comment shapes are real text from this tree
// and every one of them is legitimate documentation. A gate that reddens on a
// comment gets switched off, so this pins the lead-context rule in place.
const proseSamples: [string, string][] = [
  ["glob in a comment", ` * RabbitMQ, and Kafka and sets every ${VARIABLE_PREFIX}* URL, so these`],
  ["family names in a comment", ` * ${VARIABLE_PREFIX}SMTP_HOST / _PORT and ${VARIABLE_PREFIX}IMAP_HOST / _PORT`],
  ["bare prefix alone", ` # the same ${VARIABLE_PREFIX} values work locally and here`],
];
for (const [label, proseSource] of proseSamples) {
  const proseResult = findViolations(proseSource, "synthetic-prose.ts", canonicalNames, dynamicPrefixes);
  assert(
    `prose is not a usage: ${label}`,
    proseResult.hits.length === 0 && proseResult.violations.length === 0,
    `hits=${JSON.stringify(proseResult.hits)}`,
  );
}

// The retired spellings this batch renamed away must still be catchable, or the
// gate would not have prevented the drift it exists to prevent.
for (const retiredName of ["POSTGRES_URL", "PG_USER", "PG_PASS", "PG_DATABASE", "MONGO_URL", "CACHE_REDIS_URL"]) {
  const retiredSource = `const v = process.env.${VARIABLE_PREFIX}${retiredName};`;
  assert(
    `retired spelling still caught: ${retiredName}`,
    findViolations(retiredSource, "synthetic-retired.ts", canonicalNames, dynamicPrefixes).violations.length === 1,
  );
}
// A declared dynamic prefix is allowed through - and only exactly. The hit
// assertion matters: violations.length === 0 alone would also pass if the
// pattern never matched at all.
for (const dynamicPrefix of dynamicPrefixes) {
  const dynamicResult = findViolations(
    `process.env["${dynamicPrefix}" + suffix]`,
    "synthetic-dynamic.ts",
    canonicalNames,
    dynamicPrefixes,
  );
  assert(
    `dynamic prefix matched and allowed: ${dynamicPrefix}`,
    dynamicResult.hits.some((hit) => hit.variableName === dynamicPrefix) && dynamicResult.violations.length === 0,
    `hits=${JSON.stringify(dynamicResult.hits)} violations=${JSON.stringify(dynamicResult.violations)}`,
  );
  // ...but only EXACTLY. A longer name that merely starts with it is a violation.
  const extendedResult = findViolations(
    `process.env["${dynamicPrefix}REAL_NAME"]`,
    "synthetic-dynamic-extended.ts",
    canonicalNames,
    dynamicPrefixes,
  );
  assert(
    `dynamic prefix does not blanket-allow longer names: ${dynamicPrefix}`,
    extendedResult.violations.length === 1,
    `violations=${JSON.stringify(extendedResult.violations)}`,
  );
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Files scanned: ${filesRead}`);
console.log(`  Canonical names: ${canonicalNames.size}   Distinct names seen: ${distinctTokens.size}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
