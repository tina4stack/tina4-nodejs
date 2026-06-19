/**
 * Unit tests for the WSDL/SOAP module.
 * Run with: npx tsx test/wsdl.test.ts
 */
import { WSDLService, WSDLOperation } from "../packages/core/src/index.ts";

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

console.log("=== WSDL Tests ===\n");

// --- Create a test service ---

class Calculator extends WSDLService {
  serviceName = "Calculator";
  serviceUrl = "/api/calculator";

  async Add(a: number, b: number): Promise<Record<string, unknown>> {
    return { Result: a + b };
  }

  async Multiply(a: number, b: number): Promise<Record<string, unknown>> {
    return { Result: a * b };
  }
}

// Manually attach operation metadata (since decorators may not work at runtime)
(Calculator.prototype.Add as any)._wsdlOp = {
  name: "Add",
  description: "Add two numbers",
  input: { a: "int", b: "int" },
  output: { Result: "int" },
};

(Calculator.prototype.Multiply as any)._wsdlOp = {
  name: "Multiply",
  description: "Multiply two numbers",
  input: { a: "int", b: "int" },
  output: { Result: "int" },
};

const calc = new Calculator();

// --- generateWSDL ---
console.log("--- generateWSDL ---");

const wsdl = calc.generateWSDL("http://localhost:3000/api/calculator");

assert("generateWSDL returns string", typeof wsdl === "string");
assert("WSDL starts with XML declaration", wsdl.startsWith('<?xml version="1.0"'));
assert("WSDL contains definitions element", wsdl.includes("<definitions"));
assert("WSDL contains service name", wsdl.includes('name="Calculator"'));
assert("WSDL contains targetNamespace", wsdl.includes("urn:Calculator"));
assert("WSDL contains types section", wsdl.includes("<types>"));
assert("WSDL contains schema", wsdl.includes("<xsd:schema"));

// --- Operation type mapping ---
console.log("\n--- Operation type mapping ---");

assert("WSDL contains Add operation", wsdl.includes('name="Add"'));
assert("WSDL contains Multiply operation", wsdl.includes('name="Multiply"'));
assert("WSDL maps int to xsd:int", wsdl.includes('type="xsd:int"'));
assert("WSDL contains input params (a)", wsdl.includes('name="a"'));
assert("WSDL contains input params (b)", wsdl.includes('name="b"'));
assert("WSDL contains Result in output", wsdl.includes('name="Result"'));

// --- WSDL messages ---
console.log("\n--- WSDL messages ---");

assert("WSDL contains AddInput message", wsdl.includes('name="AddInput"'));
assert("WSDL contains AddOutput message", wsdl.includes('name="AddOutput"'));
assert("WSDL contains MultiplyInput message", wsdl.includes('name="MultiplyInput"'));
assert("WSDL contains MultiplyOutput message", wsdl.includes('name="MultiplyOutput"'));

// --- WSDL portType ---
console.log("\n--- WSDL portType ---");

assert("WSDL contains portType", wsdl.includes("CalculatorPortType"));

// --- WSDL binding ---
console.log("\n--- WSDL binding ---");

assert("WSDL contains binding", wsdl.includes("CalculatorBinding"));
assert("WSDL uses document style", wsdl.includes('style="document"'));
assert("WSDL contains SOAP operation", wsdl.includes("soapAction"));

// --- WSDL service ---
console.log("\n--- WSDL service ---");

assert("WSDL contains service element", wsdl.includes("<service"));
assert("WSDL contains port element", wsdl.includes("CalculatorPort"));
assert("WSDL contains soap:address", wsdl.includes('location="http://localhost:3000/api/calculator"'));

// --- SOAP envelope parsing ---
console.log("\n--- SOAP request handling ---");

const soapRequest = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Add>
      <a>3</a>
      <b>5</b>
    </Add>
  </soap:Body>
</soap:Envelope>`;

const soapResponse = await calc.handle(soapRequest);
assert("handle returns SOAP response", typeof soapResponse === "string");
assert("response is XML", soapResponse.includes('<?xml'));
assert("response contains Envelope", soapResponse.includes("Envelope"));
assert("response contains Body", soapResponse.includes("Body"));
assert("response contains AddResponse", soapResponse.includes("AddResponse"));
assert("response contains Result=8", soapResponse.includes("<Result>8</Result>"));

// --- SOAP multiply ---
console.log("\n--- SOAP Multiply ---");

const mulRequest = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Multiply>
      <a>6</a>
      <b>7</b>
    </Multiply>
  </soap:Body>
</soap:Envelope>`;

const mulResponse = await calc.handle(mulRequest);
assert("Multiply response contains Result=42", mulResponse.includes("<Result>42</Result>"));
assert("Multiply response contains MultiplyResponse", mulResponse.includes("MultiplyResponse"));

// --- SOAP fault: missing body ---
console.log("\n--- SOAP faults ---");

const noBodyReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
</soap:Envelope>`;

const noBodyResp = await calc.handle(noBodyReq);
assert("missing body returns SOAP fault", noBodyResp.includes("Fault"));
assert("fault code is Client", noBodyResp.includes("Client"));
assert("fault message mentions Body", noBodyResp.includes("Body"));

// --- SOAP fault: unknown operation ---
const unknownOpReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <UnknownOp><x>1</x></UnknownOp>
  </soap:Body>
</soap:Envelope>`;

const unknownOpResp = await calc.handle(unknownOpReq);
assert("unknown operation returns SOAP fault", unknownOpResp.includes("Fault"));
assert("fault mentions unknown operation", unknownOpResp.includes("UnknownOp"));

// --- SOAP fault: empty body ---
const emptyBodyReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body></soap:Body>
</soap:Envelope>`;

const emptyBodyResp = await calc.handle(emptyBodyReq);
assert("empty body returns SOAP fault", emptyBodyResp.includes("Fault"));

// --- Service with different types ---
console.log("\n--- Type mapping ---");

class StringService extends WSDLService {
  serviceName = "StringService";
  serviceUrl = "/api/strings";

  async Greet(name: string): Promise<Record<string, unknown>> {
    return { Greeting: `Hello, ${name}!` };
  }
}

(StringService.prototype.Greet as any)._wsdlOp = {
  name: "Greet",
  input: { name: "string" },
  output: { Greeting: "string" },
};

const strService = new StringService();
const strWsdl = strService.generateWSDL();
assert("string type maps to xsd:string", strWsdl.includes('type="xsd:string"'));

// --- Boolean type mapping ---
class BoolService extends WSDLService {
  serviceName = "BoolService";
  serviceUrl = "/api/bool";

  async IsEven(n: number): Promise<Record<string, unknown>> {
    return { result: n % 2 === 0 };
  }
}

(BoolService.prototype.IsEven as any)._wsdlOp = {
  name: "IsEven",
  input: { n: "int" },
  output: { result: "boolean" },
};

const boolService = new BoolService();
const boolWsdl = boolService.generateWSDL();
assert("boolean type maps to xsd:boolean", boolWsdl.includes('type="xsd:boolean"'));

// --- SOAP response with boolean ---
const boolReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <IsEven><n>4</n></IsEven>
  </soap:Body>
</soap:Envelope>`;

const boolResp = await boolService.handle(boolReq);
assert("boolean true rendered as true", boolResp.includes("<result>true</result>"));

// --- WSDL without endpoint URL uses serviceUrl ---
console.log("\n--- WSDL default endpoint ---");

const defaultWsdl = calc.generateWSDL();
assert("default endpoint uses serviceUrl", defaultWsdl.includes('location="/api/calculator"'));

// --- Security: DOCTYPE / XXE / billion-laughs rejection (item 1) ---
console.log("\n--- WSDL DOCTYPE / XXE hardening ---");

// A service that records whether its operation ever ran — proves the guard
// short-circuits BEFORE the operation is dispatched.
let addRan = false;
class GuardCalc extends WSDLService {
  serviceName = "GuardCalc";
  serviceUrl = "/api/guard";
  async Add(a: number, b: number): Promise<Record<string, unknown>> {
    addRan = true;
    return { Result: a + b };
  }
  async Divide(a: number, b: number): Promise<Record<string, unknown>> {
    if (b === 0) throw new Error("Division by zero");
    return { Result: a / b };
  }
}
(GuardCalc.prototype.Add as any)._wsdlOp = {
  name: "Add", input: { a: "int", b: "int" }, output: { Result: "int" },
};
(GuardCalc.prototype.Divide as any)._wsdlOp = {
  name: "Divide", input: { a: "int", b: "int" }, output: { Result: "float" },
};
const guard = new GuardCalc();

// NEGATIVE: classic XXE external-entity payload is rejected pre-parse.
const xxeReq =
  '<?xml version="1.0"?>'
  + '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/hostname">]>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>&xxe;</a><b>3</b></Add></soap:Body></soap:Envelope>';
addRan = false;
const xxeResp = await guard.handle(xxeReq);
assert("XXE DOCTYPE returns Client fault", xxeResp.includes("<faultcode>Client</faultcode>"));
assert("XXE fault message mentions DOCTYPE", xxeResp.includes("DOCTYPE"));
assert("XXE operation never ran", addRan === false && !xxeResp.includes("AddResponse"));

// NEGATIVE: billion-laughs (entity-expansion) payload is a DOCTYPE → rejected.
const bombReq =
  '<?xml version="1.0"?>'
  + '<!DOCTYPE lolz [<!ENTITY a "AAAAAAAAAA">'
  + '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>&b;</a><b>3</b></Add></soap:Body></soap:Envelope>';
addRan = false;
const bombResp = await guard.handle(bombReq);
assert("billion-laughs DOCTYPE returns Client fault", bombResp.includes("<faultcode>Client</faultcode>"));
assert("billion-laughs fault message mentions DOCTYPE", bombResp.includes("DOCTYPE"));
assert("billion-laughs operation never ran", addRan === false);

// Case-insensitive: lowercase <!doctype> is also rejected.
const lowerDoctype =
  '<?xml version="1.0"?><!doctype foo>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>1</a><b>2</b></Add></soap:Body></soap:Envelope>';
assert("lowercase doctype rejected", (await guard.handle(lowerDoctype)).includes("DOCTYPE"));

// POSITIVE: a normal (DTD-free) SOAP request is unaffected by the guard.
addRan = false;
const guardOk = await guard.handle(
  '<?xml version="1.0"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>7</a><b>2</b></Add></soap:Body></soap:Envelope>',
);
assert("valid request still works after guard", guardOk.includes("<Result>9</Result>"));
assert("valid request ran the operation", addRan === true);

// --- Security: operation error masked in prod / detailed in debug (item 2) ---
console.log("\n--- WSDL operation error masking ---");

const divideReq =
  '<?xml version="1.0"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Divide><a>10</a><b>0</b></Divide></soap:Body></soap:Envelope>';

const savedDebug = process.env.TINA4_DEBUG;
const savedOut = process.env.TINA4_LOG_OUTPUT;
process.env.TINA4_LOG_OUTPUT = "file"; // keep test stdout clean

// NEGATIVE (prod): the real cause must NOT leak — generic Server fault.
delete process.env.TINA4_DEBUG;
const maskedResp = await guard.handle(divideReq);
assert("op error returns Server fault", maskedResp.includes("<faultcode>Server</faultcode>"));
assert("op error masked in prod", maskedResp.includes("Internal server error"));
assert("op error detail not leaked in prod", !maskedResp.includes("Division by zero"));

// POSITIVE (debug): the real cause is surfaced to aid local development.
process.env.TINA4_DEBUG = "true";
const debugResp = await guard.handle(divideReq);
assert("op error detail surfaced in debug", debugResp.includes("Division by zero"));
assert("op error still Server fault in debug", debugResp.includes("<faultcode>Server</faultcode>"));

// --- convertValue NaN → Server fault (item 3) ---
console.log("\n--- WSDL convertValue NaN guard ---");

// NEGATIVE: a non-numeric value for an int param raises → Server fault.
// (Run in debug so we can assert the detail; the masking is covered above.)
process.env.TINA4_DEBUG = "true";
const nanReq =
  '<?xml version="1.0"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>notanumber</a><b>3</b></Add></soap:Body></soap:Envelope>';
const nanResp = await guard.handle(nanReq);
assert("non-numeric int returns Server fault", nanResp.includes("<faultcode>Server</faultcode>"));
assert("non-numeric int fault mentions invalid integer", nanResp.includes("invalid integer"));
assert("non-numeric int did not return AddResponse", !nanResp.includes("<Result>"));

// NEGATIVE: a non-numeric value for a float param also faults.
const nanFloatReq =
  '<?xml version="1.0"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Divide><a>oops</a><b>2</b></Divide></soap:Body></soap:Envelope>';
const nanFloatResp = await guard.handle(nanFloatReq);
assert("non-numeric float returns Server fault", nanFloatResp.includes("<faultcode>Server</faultcode>"));

// POSITIVE: a valid number still converts and works.
const validNumResp = await guard.handle(
  '<?xml version="1.0"?>'
  + '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><Add><a>4</a><b>5</b></Add></soap:Body></soap:Envelope>',
);
assert("valid number still works", validNumResp.includes("<Result>9</Result>"));

// restore env
if (savedDebug === undefined) delete process.env.TINA4_DEBUG;
else process.env.TINA4_DEBUG = savedDebug;
if (savedOut === undefined) delete process.env.TINA4_LOG_OUTPUT;
else process.env.TINA4_LOG_OUTPUT = savedOut;

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
