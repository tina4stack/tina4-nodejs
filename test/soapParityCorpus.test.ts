/**
 * SOAP parity corpus - the ten payloads every framework answers the same way.
 *
 * The reference is Python's `WSDL._process_soap` (tina4_python/wsdl/__init__.py).
 * Each payload is fed to the real handler, byte for byte: as the raw request
 * Buffer, and as the string Node's request parser hands a route
 * (`raw.toString("utf-8")`, packages/core/src/request.ts). Both must give the
 * reference answer.
 *
 * Three bugs this pins (all reproduced red before the fix):
 *   - a single-parameter operation always received null (payload 02);
 *   - entities, character references and CDATA were never decoded (03, 04);
 *   - malformed XML answered "Missing SOAP Body" instead of "Malformed XML" (05).
 * And one refusal: a UTF-16 body with a byte-order mark is refused before any
 * parse, so its DOCTYPE can never be expanded (10).
 *
 * Pure logic over the real handler: no server, no double.
 * Run with: npx tsx test/soapParityCorpus.test.ts
 */
import { WSDLService } from "../packages/core/src/index.ts";

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

class ParityService extends WSDLService {
  serviceName = "Parity";
  serviceUrl = "/soap/parity";
  calls: string[] = [];

  async Add(a: number, b: number): Promise<Record<string, unknown>> {
    this.calls.push("Add");
    return { Result: a + b };
  }

  async Echo(text: string): Promise<Record<string, unknown>> {
    this.calls.push("Echo");
    return { Result: text };
  }
}

(ParityService.prototype.Add as unknown as Record<string, unknown>)._wsdlOp = {
  name: "Add", input: { a: "int", b: "int" }, output: { Result: "int" },
};
(ParityService.prototype.Echo as unknown as Record<string, unknown>)._wsdlOp = {
  name: "Echo", input: { text: "string" }, output: { Result: "string" },
};

// The corpus (scratchpad soap-parity/payloads.json), bodies as base64 so the
// UTF-16 payload survives byte-exact.
const corpus: Array<{ name: string; body: string; expect: { fault?: string; message?: string; result?: string } }> = [
  {
    name: "01-add-two-params",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpBZGQ+PHQ6YT4yPC90OmE+PHQ6Yj4zPC90OmI+PC90OkFkZD48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { result: "5" },
  },
  {
    name: "02-echo-single-param",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpFY2hvPjx0OnRleHQ+aGVsbG88L3Q6dGV4dD48L3Q6RWNobz48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { result: "hello" },
  },
  {
    name: "03-echo-named-entities",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpFY2hvPjx0OnRleHQ+VG9tICZhbXA7IEplcnJ5ICZsdDszJmd0OyAmcXVvdDtxJnF1b3Q7ICZhcG9zO2EmYXBvczs8L3Q6dGV4dD48L3Q6RWNobz48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { result: `Tom & Jerry <3> "q" 'a'` },
  },
  {
    name: "04-echo-numeric-refs-and-cdata",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpFY2hvPjx0OnRleHQ+JiM2NTsmI3g0Mjs8IVtDREFUQVs8Yz5dXT48L3Q6dGV4dD48L3Q6RWNobz48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { result: "AB<c>" },
  },
  {
    name: "05-malformed-unclosed",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpFY2hvPjx0OnRleHQ+aGVsbG88L3Q6RWNobz48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { fault: "Client", message: "Malformed XML" },
  },
  {
    name: "06-no-body",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHNvYXA6RW52ZWxvcGUgeG1sbnM6c29hcD0iaHR0cDovL3NjaGVtYXMueG1sc29hcC5vcmcvc29hcC9lbnZlbG9wZS8iPjxzb2FwOkhlYWRlci8+PC9zb2FwOkVudmVsb3BlPg==",
    expect: { fault: "Client", message: "Missing SOAP Body" },
  },
  {
    name: "07-empty-body",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { fault: "Client", message: "Empty SOAP Body" },
  },
  {
    name: "08-unknown-operation",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c29hcDpFbnZlbG9wZSB4bWxuczpzb2FwPSJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy9zb2FwL2VudmVsb3BlLyIgeG1sbnM6dD0idXJuOnRpbmE0OnBhcml0eSI+PHNvYXA6Qm9keT48dDpOb3BlPjx0Ong+MTwvdDp4PjwvdDpOb3BlPjwvc29hcDpCb2R5Pjwvc29hcDpFbnZlbG9wZT4=",
    expect: { fault: "Client", message: "Unknown operation: Nope" },
  },
  {
    name: "09-doctype-utf8",
    body: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PCFET0NUWVBFIHNvYXA6RW52ZWxvcGUgWzwhRU5USVRZIGUgIkVYUEFOREVEIj5dPjxzb2FwOkVudmVsb3BlIHhtbG5zOnNvYXA9Imh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3NvYXAvZW52ZWxvcGUvIiB4bWxuczp0PSJ1cm46dGluYTQ6cGFyaXR5Ij48c29hcDpCb2R5Pjx0OkVjaG8+PHQ6dGV4dD4mZTs8L3Q6dGV4dD48L3Q6RWNobz48L3NvYXA6Qm9keT48L3NvYXA6RW52ZWxvcGU+",
    expect: { fault: "Client", message: "DOCTYPE declarations are not allowed in SOAP messages" },
  },
  {
    name: "10-doctype-utf16-bom",
    body: "//48AD8AeABtAGwAIAB2AGUAcgBzAGkAbwBuAD0AIgAxAC4AMAAiACAAZQBuAGMAbwBkAGkAbgBnAD0AIgBVAFQARgAtADEANgAiAD8APgA8ACEARABPAEMAVABZAFAARQAgAHMAbwBhAHAAOgBFAG4AdgBlAGwAbwBwAGUAIABbADwAIQBFAE4AVABJAFQAWQAgAGUAIAAiAEUAWABQAEEATgBEAEUARAAiAD4AXQA+ADwAcwBvAGEAcAA6AEUAbgB2AGUAbABvAHAAZQAgAHgAbQBsAG4AcwA6AHMAbwBhAHAAPQAiAGgAdAB0AHAAOgAvAC8AcwBjAGgAZQBtAGEAcwAuAHgAbQBsAHMAbwBhAHAALgBvAHIAZwAvAHMAbwBhAHAALwBlAG4AdgBlAGwAbwBwAGUALwAiACAAeABtAGwAbgBzADoAdAA9ACIAdQByAG4AOgB0AGkAbgBhADQAOgBwAGEAcgBpAHQAeQAiAD4APABzAG8AYQBwADoAQgBvAGQAeQA+ADwAdAA6AEUAYwBoAG8APgA8AHQAOgB0AGUAeAB0AD4AJgBlADsAPAAvAHQAOgB0AGUAeAB0AD4APAAvAHQAOgBFAGMAaABvAD4APAAvAHMAbwBhAHAAOgBCAG8AZAB5AD4APAAvAHMAbwBhAHAAOgBFAG4AdgBlAGwAbwBwAGUAPgA=",
    expect: { fault: "Client", message: "Malformed XML" },
  },
];

/** Undo the escaping soapResponse()/soapFault() apply to a text node. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

interface Outcome { fault: string | null; message: string | null; result: string | null; expanded: boolean }

function readOutcome(response: string): Outcome {
  const fault = response.match(/<faultcode>([^<]*)<\/faultcode>/);
  const message = response.match(/<faultstring>([^<]*)<\/faultstring>/);
  const result = response.match(/<Result>([^<]*)<\/Result>/);
  return {
    fault: fault ? fault[1] : null,
    message: message ? unescapeXml(message[1]) : null,
    result: result ? unescapeXml(result[1]) : null,
    expanded: response.includes("EXPANDED"),
  };
}

function describe(outcome: Outcome): string {
  return outcome.fault !== null
    ? `fault ${outcome.fault}: ${outcome.message}`
    : `result ${JSON.stringify(outcome.result)}`;
}

console.log("=== SOAP parity corpus (Python _process_soap is the reference) ===\n");

const table: string[] = [];

for (const payload of corpus) {
  const bytes = Buffer.from(payload.body, "base64");
  // The two ways a body reaches handle(): the raw bytes, and the string Node's
  // request parser produces for a text/xml route (a lossy UTF-8 decode).
  const inputs: Array<[string, Buffer | string]> = [
    ["bytes", bytes],
    ["string", bytes.toString("utf-8")],
  ];
  for (const [form, input] of inputs) {
    const service = new ParityService();
    const outcome = readOutcome(await service.handle(input));
    const label = `${payload.name} (${form})`;
    if (payload.expect.fault) {
      assert(`${label}: ${payload.expect.fault} fault "${payload.expect.message}"`,
        outcome.fault === payload.expect.fault && outcome.message === payload.expect.message,
        `got ${describe(outcome)}`);
      assert(`${label}: no operation ran`, service.calls.length === 0, `ran ${service.calls.join(",")}`);
    } else {
      assert(`${label}: Result = ${JSON.stringify(payload.expect.result)}`,
        outcome.fault === null && outcome.result === payload.expect.result, `got ${describe(outcome)}`);
    }
    assert(`${label}: EXPANDED never appears in the response`, !outcome.expanded);
    if (form === "bytes") {
      table.push(`| ${payload.name} | ${outcome.fault ?? "result"} | ${outcome.fault !== null ? outcome.message : outcome.result} | ${outcome.expanded ? "yes" : "no"} |`);
    }
  }
}

console.log("\n--- Byte-level refusals beyond the corpus ---");
{
  const envelope = (inner: string) =>
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="urn:t"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
  const echo = (text: string) => envelope(`<t:Echo><t:text>${text}</t:text></t:Echo>`);

  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(echo("hi"))]);
  assert("a UTF-8 byte-order mark is refused as Malformed XML",
    readOutcome(await new ParityService().handle(utf8Bom)).message === "Malformed XML");

  const latin1 = Buffer.from(echo("café"), "latin1");
  assert("bytes that are not UTF-8 (Latin-1) are refused as Malformed XML",
    readOutcome(await new ParityService().handle(latin1)).message === "Malformed XML");

  const bomString = readOutcome(await new ParityService().handle("\uFEFF" + echo("hi")));
  assert("a byte-order mark at the start of an already-decoded body is refused as Malformed XML",
    bomString.message === "Malformed XML", describe(bomString));

  const nulInText = readOutcome(await new ParityService().handle(echo("a\u0000b")));
  assert("a NUL character (never legal in XML) is refused as Malformed XML", nulInText.message === "Malformed XML",
    describe(nulInText));

  const utf16NoBom = Buffer.from(echo("hi"), "utf16le");
  assert("UTF-16 without a byte-order mark is refused as Malformed XML (its NULs are not XML)",
    readOutcome(await new ParityService().handle(utf16NoBom)).message === "Malformed XML");

  const multibyte = readOutcome(await new ParityService().handle(Buffer.from(echo("café 東京"))));
  assert("POSITIVE: valid multi-byte UTF-8 still round-trips", multibyte.result === "café 東京",
    JSON.stringify(multibyte));

  for (const [label, body] of [
    ["an undefined entity", echo("&nope;")],
    ["a bare ampersand", echo("a & b")],
    ["a mismatched close tag", envelope("<t:Echo><t:text>x</t:wrong></t:Echo>")],
    ["content after the root element", echo("x") + "<extra/>"],
    ["an unclosed root element", echo("x").replace("</soap:Envelope>", "")],
    ["an unquoted attribute", envelope(`<t:Echo id=1><t:text>x</t:text></t:Echo>`)],
    ["a character reference to NUL", echo("&#0;")],
  ] as const) {
    const outcome = readOutcome(await new ParityService().handle(body));
    assert(`${label} is Malformed XML`, outcome.message === "Malformed XML", describe(outcome));
  }

  const commented = readOutcome(await new ParityService().handle(
    envelope(`<!-- a comment --><t:Add><t:a> 2 </t:a><?pi data?><t:b>40</t:b></t:Add>`)));
  assert("POSITIVE: comments and processing instructions are skipped", commented.result === "42", describe(commented));
}

console.log("\n| payload | outcome | faultstring / Result | EXPANDED |");
console.log("|---|---|---|---|");
for (const row of table) console.log(row);

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
