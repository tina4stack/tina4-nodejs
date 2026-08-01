/**
 * Regression tests for the RS256-opt-in ruling (HMAC is the Tina4 standard).
 *
 * The ruling, in three lines:
 *   1. HS256 / HS384 / HS512 is THE algorithm family, zero-dependency in all
 *      four frameworks. Node gets it from builtin `node:crypto`.
 *   2. RS256 is an OPT-IN EXTRA, offered only where the RUNTIME provides
 *      asymmetric crypto natively. It is never a third-party dependency.
 *   3. Where it is unavailable it fails LOUDLY and ACTIONABLY at the point of
 *      use — never a silent fallback, never a mysterious `false`.
 *
 * Node is the REFERENCE for "RS256 available": node:crypto is builtin, so the
 * asymmetric path is always there. What this file pins for Node is therefore the
 * CONTRACT the other three are checked against — the capability check, the
 * loud-failure shape, the algorithm pin, and a cross-framework token fixture
 * that tina4-php / tina4-ruby must verify byte-for-byte.
 *
 * No doubles anywhere: real node:crypto primitives, real key pairs, real tokens,
 * and a real read of the repository's own source and manifests.
 *
 * Run with: npx tsx test/authRs256OptIn.test.ts
 */
import { createHmac, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  algorithmAvailable,
  availableAlgorithms,
  getToken,
  resolveAlgorithm,
  validToken,
} from "../packages/core/src/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

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

/** Assert that `fn` throws, and hand the message to a predicate. */
function assertThrows(label: string, fn: () => unknown, messageCheck: (message: string) => boolean) {
  try {
    fn();
    assert(label, false);
  } catch (error) {
    assert(label, messageCheck(error instanceof Error ? error.message : String(error)));
  }
}

const SECRET = "rs256-optin-regression-secret";
const HMAC_ALGORITHMS = ["HS256", "HS384", "HS512"] as const;
const DIGEST_BYTES: Record<string, { digest: string; bytes: number }> = {
  HS256: { digest: "sha256", bytes: 32 },
  HS384: { digest: "sha384", bytes: 48 },
  HS512: { digest: "sha512", bytes: 64 },
};

process.env.TINA4_SECRET = SECRET;
delete process.env.TINA4_JWT_ALGORITHM;

function base64urlEncode(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): Buffer {
  let s = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = 4 - (s.length % 4);
  if (pad !== 4) s += "=".repeat(pad);
  return Buffer.from(s, "base64");
}

/** Re-header an existing token: keep its payload + signature, swap only `alg`. */
function reHeader(token: string, alg: string): string {
  const [, payload, signature] = token.split(".");
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg, typ: "JWT" })));
  return `${header}.${payload}.${signature}`;
}

console.log("=== RS256 opt-in / HMAC-is-the-standard regression tests ===\n");

// ── 1. HMAC is the standard, and it is genuinely available here ────

console.log("-- hmac_is_the_four_way_standard --");

for (const algorithm of HMAC_ALGORITHMS) {
  // POSITIVE: the capability check says yes, and the algorithm really works —
  // signature recomputable from node:crypto directly, right digest size, and a
  // full sign -> validate round trip through the framework.
  assert(`${algorithm}: algorithmAvailable() is true`, algorithmAvailable(algorithm) === true);
  assert(
    `${algorithm}: availableAlgorithms() lists it`,
    availableAlgorithms().includes(algorithm),
  );

  const token = getToken({ userId: 7 }, SECRET, 60, algorithm);
  const signingInput = token.split(".").slice(0, 2).join(".");
  const expected = base64urlEncode(
    createHmac(DIGEST_BYTES[algorithm].digest, SECRET).update(signingInput).digest(),
  );
  assert(
    `${algorithm}: signature equals an independently computed ${DIGEST_BYTES[algorithm].digest} HMAC`,
    token.split(".")[2] === expected,
  );
  assert(
    `${algorithm}: signature is ${DIGEST_BYTES[algorithm].bytes} raw bytes`,
    base64urlDecode(token.split(".")[2]).length === DIGEST_BYTES[algorithm].bytes,
  );
  assert(
    `${algorithm}: sign -> validate round trip returns the payload`,
    validToken(token, SECRET, algorithm)?.userId === 7,
  );
}

{
  // The HMAC family comes FIRST — it is the standard, RS256 is the extra.
  assert(
    "availableAlgorithms() leads with the HMAC family, RS256 after it",
    availableAlgorithms().slice(0, 3).join(",") === "HS256,HS384,HS512",
  );
  // The default, with nothing configured, is an HMAC algorithm.
  delete process.env.TINA4_JWT_ALGORITHM;
  assert("the unconfigured default is HS256 (HMAC)", resolveAlgorithm() === "HS256");
}

{
  // NEGATIVE: the capability check is not a rubber stamp. Anything Tina4 does
  // not know is unavailable, including the empty string and "none".
  for (const bogus of ["HS999", "none", "", "  ", "RS512", "ES256", "toString"]) {
    assert(
      `algorithmAvailable(${JSON.stringify(bogus)}) is false`,
      algorithmAvailable(bogus) === false,
    );
    assert(
      `availableAlgorithms() excludes ${JSON.stringify(bogus)}`,
      !availableAlgorithms().includes(bogus),
    );
  }
}

// ── 2. RS256 is available in Node — the reference implementation ───

console.log("\n-- rs256_available_in_node --");

const rsa = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

{
  // POSITIVE: node:crypto is builtin, so RS256 is legitimately available at zero
  // dependency cost. This is the shape the other three are checked against.
  assert("RS256: algorithmAvailable() is true in Node", algorithmAvailable("RS256") === true);
  assert("RS256: availableAlgorithms() lists it", availableAlgorithms().includes("RS256"));
  assert("RS256: resolveAlgorithm('RS256') returns it", resolveAlgorithm("RS256") === "RS256");

  const token = getToken({ userId: 99 }, rsa.privateKey, 60, "RS256");
  assert(
    "RS256: the private key signs and the PUBLIC key alone verifies",
    validToken(token, rsa.publicKey, "RS256")?.userId === 99,
  );

  // NEGATIVE: a different key pair must never verify it, and a tampered payload
  // must go invalid — otherwise "it verified" would prove nothing.
  const other = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  assert(
    "RS256: a different public key never validates the token",
    validToken(token, other.publicKey, "RS256") === null,
  );
  const [h, , sig] = token.split(".");
  const tampered = `${h}.${base64urlEncode(Buffer.from(JSON.stringify({ userId: 1, admin: true })))}.${sig}`;
  assert("RS256: a tampered payload is rejected", validToken(tampered, rsa.publicKey, "RS256") === null);
}

// ── 3. The capability check is a REAL runtime probe ────────────────

console.log("\n-- capability_check_probes_the_runtime --");

{
  // A capability check that always answers "yes" is not a capability check. The
  // probe runs the actual primitive, so it can only answer yes when the runtime
  // really provides it, and it has a real failure mode.
  //
  // POSITIVE control: the primitives behind the algorithms we report as
  // available really do run here.
  for (const algorithm of HMAC_ALGORITHMS) {
    let ok = true;
    try {
      createHmac(DIGEST_BYTES[algorithm].digest, "probe").update("").digest();
    } catch {
      ok = false;
    }
    assert(`${algorithm}: the reported availability is earned by a working primitive`, ok);
  }
  let rsaOk = true;
  try {
    createSign("RSA-SHA256").update("");
    createVerify("RSA-SHA256").update("");
  } catch {
    rsaOk = false;
  }
  assert("RS256: the reported availability is earned by a working primitive", rsaOk);

  // NEGATIVE control: the probe's mechanism genuinely CAN say no. An algorithm
  // name this OpenSSL does not provide raises out of the very call the probe
  // makes, which is what the loud "not available" failure is built from. Without
  // this, a probe that could never fail would look identical to a hardcoded true.
  let refused = "";
  try {
    createSign("RSA-MD4").update("");
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert(
    "the probe's own call refuses an algorithm this runtime does not provide",
    refused.length > 0,
  );

  // And the reported set is exactly the set whose primitive runs — computed
  // here independently of the framework's own bookkeeping.
  const independentlyAvailable = ["HS256", "HS384", "HS512", "RS256"].filter((algorithm) => {
    try {
      if (algorithm.startsWith("HS")) createHmac(DIGEST_BYTES[algorithm].digest, "p").update("").digest();
      else createSign("RSA-SHA256").update("");
      return true;
    } catch {
      return false;
    }
  });
  assert(
    "availableAlgorithms() matches an independent probe of node:crypto",
    availableAlgorithms().join(",") === independentlyAvailable.join(","),
  );
}

// ── 4. Algorithm pinning survives RS256 becoming optional ──────────
//
// Algorithm substitution is the classic JWT attack. Making RS256 optional must
// not open it: under an HMAC configuration a token whose header claims RS256 is
// REJECTED, and alg:"none" stays REJECTED.

console.log("\n-- alg_pinning_under_hmac_config --");

for (const configured of HMAC_ALGORITHMS) {
  const good = getToken({ userId: 5 }, SECRET, 60, configured);

  // POSITIVE control first: the pin rejects substitutions, not everything.
  assert(
    `${configured}: the untampered token still validates`,
    validToken(good, SECRET, configured)?.userId === 5,
  );

  // NEGATIVE: header says RS256 over the HMAC signature.
  assert(
    `${configured}: a token whose header claims RS256 is REJECTED`,
    validToken(reHeader(good, "RS256"), SECRET, configured) === null,
  );

  // NEGATIVE: a GENUINELY RSA-signed token offered to an HMAC verifier. The
  // public PEM is not secret, so this is the realistic attack shape.
  const realRsaToken = getToken({ userId: 5 }, rsa.privateKey, 60, "RS256");
  assert(
    `${configured}: a genuinely RS256-signed token is REJECTED under HMAC config`,
    validToken(realRsaToken, SECRET, configured) === null,
  );
  assert(
    `${configured}: the same RS256 token is also rejected when the public key is the secret`,
    validToken(realRsaToken, rsa.publicKey, configured) === null,
  );

  // NEGATIVE: alg:"none", empty signature — the classic bypass.
  const noneHeader = base64urlEncode(Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })));
  const payloadPart = good.split(".")[1];
  assert(
    `${configured}: alg:"none" with an empty signature is REJECTED`,
    validToken(`${noneHeader}.${payloadPart}.`, SECRET, configured) === null,
  );
  // NEGATIVE: alg:"none" carrying the real signature — an empty-signature-only
  // check would let this through.
  assert(
    `${configured}: alg:"none" carrying the real signature is REJECTED`,
    validToken(reHeader(good, "none"), SECRET, configured) === null,
  );

  // NEGATIVE: a different, genuinely-signed HMAC algorithm is refused too.
  for (const other of HMAC_ALGORITHMS.filter((a) => a !== configured)) {
    assert(
      `${configured}: a real ${other} token is REJECTED`,
      validToken(getToken({ userId: 5 }, SECRET, 60, other), SECRET, configured) === null,
    );
  }
}

{
  // ── THE gate on the algorithm-pin line itself ──
  //
  // MEASURED: every re-labelled-header case above is refused even by an
  // implementation with NO pin, because the header is part of the HMAC signing
  // input — rewrite it and the recomputed signature stops matching. These two
  // shapes are different, and only the pin refuses them:
  //
  //   1. duplicate `alg` key — the header BYTES are untouched, so the original
  //      signature still verifies, but JSON.parse (like PHP json_decode, Python
  //      json.loads, Ruby JSON.parse) takes the LAST duplicate, so the token
  //      PARSES as the smuggled algorithm. A real split-brain shape: a gateway
  //      reading the first `alg` and a backend acting on the last see two
  //      different tokens.
  //   2. re-signed lying header — an honest single-key header naming the
  //      smuggled algorithm, with the HMAC recomputed over it so it verifies.
  const payloadPart = base64urlEncode(Buffer.from(JSON.stringify({ userId: 42, exp: 4102444800 })));

  for (const [honest, smuggled] of [
    ["HS256", "none"],
    ["HS256", "RS256"],
    ["HS512", "HS256"],
    ["HS384", "HS512"],
  ] as const) {
    const digest = DIGEST_BYTES[honest].digest;

    const rawHeader = `{"alg":"${honest}","alg":"${smuggled}","typ":"JWT"}`;
    assert(
      `${honest}/${smuggled}: CONTROL the duplicate-key header parses as ${smuggled}`,
      (JSON.parse(rawHeader) as { alg: string }).alg === smuggled,
    );
    const dupHeader = base64urlEncode(Buffer.from(rawHeader));
    const dupInput = `${dupHeader}.${payloadPart}`;
    const dupToken = `${dupInput}.${base64urlEncode(createHmac(digest, SECRET).update(dupInput).digest())}`;
    assert(
      `${honest}: a valid signature whose header PARSES as ${smuggled} is REJECTED`,
      validToken(dupToken, SECRET, honest) === null,
    );

    const lyingHeader = base64urlEncode(Buffer.from(JSON.stringify({ alg: smuggled, typ: "JWT" })));
    const lyingInput = `${lyingHeader}.${payloadPart}`;
    const resigned = `${lyingInput}.${base64urlEncode(createHmac(digest, SECRET).update(lyingInput).digest())}`;
    assert(
      `${honest}: a token advertising ${smuggled}, correctly re-signed, is REJECTED`,
      validToken(resigned, SECRET, honest) === null,
    );
  }

  // POSITIVE control: the same construction with ONE honest alg validates, so
  // the rejections above are the pin and not the construction.
  const honestHeader = base64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const honestInput = `${honestHeader}.${payloadPart}`;
  const honestToken = `${honestInput}.${base64urlEncode(createHmac("sha256", SECRET).update(honestInput).digest())}`;
  assert(
    "CONTROL: the same construction with an honest alg still validates",
    validToken(honestToken, SECRET, "HS256")?.userId === 42,
  );
}

{
  // The pin is enforced through the ENVIRONMENT too, not only the explicit
  // argument — that is how a real deployment configures it.
  process.env.TINA4_JWT_ALGORITHM = "HS256";
  const rsaToken = getToken({ userId: 6 }, rsa.privateKey, 60, "RS256");
  assert(
    "TINA4_JWT_ALGORITHM=HS256: an RS256 token is REJECTED",
    validToken(rsaToken, SECRET) === null,
  );
  const forged = reHeader(getToken({ userId: 6 }, SECRET), "RS256");
  assert(
    "TINA4_JWT_ALGORITHM=HS256: an RS256-claiming header is REJECTED",
    validToken(forged, SECRET) === null,
  );
  assert(
    'TINA4_JWT_ALGORITHM=HS256: alg:"none" is REJECTED',
    validToken(reHeader(getToken({ userId: 6 }, SECRET), "none"), SECRET) === null,
  );
  assert(
    "TINA4_JWT_ALGORITHM=HS256: the untampered token still validates",
    validToken(getToken({ userId: 6 }, SECRET), SECRET)?.userId === 6,
  );
  delete process.env.TINA4_JWT_ALGORITHM;
}

// ── 5. An algorithm we cannot provide fails LOUDLY ─────────────────

console.log("\n-- unavailable_algorithm_fails_loudly --");

{
  // An algorithm Tina4 does not know names the alg, what Tina4 knows, what is
  // available HERE, and the env var to change. Never a silent downgrade.
  const isLoud = (message: string) =>
    message.includes("banana") &&
    ["HS256", "HS384", "HS512", "RS256"].every((a) => message.includes(a)) &&
    message.includes("TINA4_JWT_ALGORITHM");

  assertThrows("resolveAlgorithm('banana') throws a loud, actionable error", () => resolveAlgorithm("banana"), isLoud);
  assertThrows(
    "getToken with an unknown algorithm throws rather than downgrading to HS256",
    () => getToken({ userId: 1 }, SECRET, 60, "banana"),
    isLoud,
  );

  process.env.TINA4_JWT_ALGORITHM = "banana";
  assertThrows(
    "an unknown TINA4_JWT_ALGORITHM throws at getToken",
    () => getToken({ userId: 1 }),
    isLoud,
  );
  assertThrows(
    "an unknown TINA4_JWT_ALGORITHM throws at validToken too (both paths agree)",
    () => validToken("a.b.c"),
    isLoud,
  );
  delete process.env.TINA4_JWT_ALGORITHM;

  // The message tells the truth about THIS runtime: in Node all four are
  // available, so the available list must name RS256 as well.
  try {
    resolveAlgorithm("banana");
    assert("resolveAlgorithm('banana') throws", false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      "the loud error reports the algorithms available in THIS runtime",
      message.includes(availableAlgorithms().join(", ")),
    );
  }

  // NEGATIVE: only a CONFIGURATION error escapes. A merely malformed token under
  // a valid algorithm still returns null, so a bad request is not an exception.
  assert("a malformed token under a valid algorithm still returns null", validToken("not.a.jwt") === null);
  assert("an empty token still returns null", validToken("") === null);
}

// ── 6. Cross-framework fixture — the contract the other three verify ──

console.log("\n-- cross_framework_jwt_fixture --");

{
  const fixturePath = join(repoRoot, "test", "fixtures", "jwt_cross_framework.json");
  type KeyName = "hmacSecret" | "wrongSecret" | "rs256PublicKey";
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    hmacSecret: string;
    wrongSecret: string;
    rs256PublicKey: string;
    expectedPayload: Record<string, unknown>;
    accept: { name: string; algorithm: string; key: KeyName; token: string }[];
    reject: { name: string; algorithm: string; key: KeyName; token: string }[];
  };
  const keyFor = (name: KeyName) => fixture[name];
  assert(
    "fixture: the wrong-key control really is a different secret",
    fixture.wrongSecret.length > 0 && fixture.wrongSecret !== fixture.hmacSecret,
  );
  /** Key order is not part of the contract — sort before comparing, so all four agree. */
  const canonical = (value: Record<string, unknown> | null) =>
    value === null
      ? "null"
      : JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])));

  assert("fixture: it carries every HMAC algorithm plus RS256", fixture.accept.length === 4);
  for (const entry of fixture.accept) {
    const payload = validToken(entry.token, keyFor(entry.key), entry.algorithm);
    assert(`fixture accept: ${entry.name} validates`, payload !== null);
    assert(
      `fixture accept: ${entry.name} yields the expected claims`,
      canonical(payload) === canonical(fixture.expectedPayload),
    );
  }
  assert("fixture: it carries the substitution and tamper cases", fixture.reject.length >= 6);
  for (const entry of fixture.reject) {
    assert(
      `fixture reject: ${entry.name} is rejected under ${entry.algorithm}`,
      validToken(entry.token, keyFor(entry.key), entry.algorithm) === null,
    );
  }
  assert(
    "fixture: the RS256 material is a PUBLIC key only (no private key is committed)",
    fixture.rs256PublicKey.includes("BEGIN PUBLIC KEY") &&
      !JSON.stringify(fixture).includes("PRIVATE KEY"),
  );
}

// ── 7. No third-party crypto is reachable from the auth path ───────

console.log("\n-- auth_path_has_no_third_party_crypto --");

{
  // Walk the real import graph from auth.ts and assert every non-relative
  // specifier is a node: builtin. Comments are stripped first — the file's own
  // JSDoc contains `import { Auth } from "tina4-nodejs"` as an EXAMPLE, and a
  // naive scan reads that as a dependency.
  const seen = new Set<string>();
  const external: string[] = [];
  const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;

  function walk(file: string): void {
    if (seen.has(file)) return;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const match of code.matchAll(SPECIFIER)) {
      const spec = match[1];
      if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
      if (spec.startsWith(".")) {
        walk(resolve(dirname(file), spec).replace(/\.js$/, ".ts"));
        continue;
      }
      external.push(`${spec} (from ${file.replace(repoRoot + "/", "")})`);
    }
  }
  walk(join(repoRoot, "packages", "core", "src", "auth.ts"));
  walk(join(repoRoot, "packages", "core", "src", "authGate.ts"));

  // POSITIVE control: the walk really visited the auth sources. Without this an
  // unreadable path would produce an empty graph and look like a clean pass.
  assert("the import walk reached auth.ts and its neighbours", seen.size >= 4);
  assert(
    `the auth path imports nothing but node: builtins${external.length ? " — found " + external.join(", ") : ""}`,
    external.length === 0,
  );

  // And no manifest declares a crypto/JWT package in ANY dependency section.
  const FORBIDDEN =
    /(jsonwebtoken|node-jose|^jose$|jwt-simple|node-rsa|bcrypt|argon2|crypto-js|tweetnacl|elliptic|jwa|jws)/i;
  const manifests = [
    "package.json",
    "packages/core/package.json",
    "packages/orm/package.json",
    "packages/swagger/package.json",
    "packages/frond/package.json",
    "packages/cli/package.json",
  ];
  const offenders: string[] = [];
  let namesRead = 0;
  for (const manifest of manifests) {
    const json = JSON.parse(readFileSync(join(repoRoot, manifest), "utf-8")) as Record<string, unknown>;
    for (const section of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
      "bundledDependencies",
    ]) {
      const block = json[section] as Record<string, string> | undefined;
      for (const name of Object.keys(block ?? {})) {
        namesRead++;
        if (FORBIDDEN.test(name)) offenders.push(`${manifest}:${section}:${name}`);
      }
    }
  }
  // POSITIVE control: the manifests really were read and really do declare
  // packages, so "no offenders" is a finding rather than an empty scan.
  assert("the manifest scan actually read declared package names", namesRead > 0);
  assert(
    `no manifest declares a third-party crypto/JWT package${offenders.length ? " — found " + offenders.join(", ") : ""}`,
    offenders.length === 0,
  );
}

// ── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
