/**
 * Unit tests for the WSDL/SOAP module.
 * Run with: npx tsx test/wsdl.test.ts
 */
import { WSDLService, WSDLOp } from "../packages/core/src/index.ts";

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

const soapResponse = await calc.handleRequest(soapRequest);
assert("handleRequest returns SOAP response", typeof soapResponse === "string");
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

const mulResponse = await calc.handleRequest(mulRequest);
assert("Multiply response contains Result=42", mulResponse.includes("<Result>42</Result>"));
assert("Multiply response contains MultiplyResponse", mulResponse.includes("MultiplyResponse"));

// --- SOAP fault: missing body ---
console.log("\n--- SOAP faults ---");

const noBodyReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
</soap:Envelope>`;

const noBodyResp = await calc.handleRequest(noBodyReq);
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

const unknownOpResp = await calc.handleRequest(unknownOpReq);
assert("unknown operation returns SOAP fault", unknownOpResp.includes("Fault"));
assert("fault mentions unknown operation", unknownOpResp.includes("UnknownOp"));

// --- SOAP fault: empty body ---
const emptyBodyReq = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body></soap:Body>
</soap:Envelope>`;

const emptyBodyResp = await calc.handleRequest(emptyBodyReq);
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

const boolResp = await boolService.handleRequest(boolReq);
assert("boolean true rendered as true", boolResp.includes("<result>true</result>"));

// --- WSDL without endpoint URL uses serviceUrl ---
console.log("\n--- WSDL default endpoint ---");

const defaultWsdl = calc.generateWSDL();
assert("default endpoint uses serviceUrl", defaultWsdl.includes('location="/api/calculator"'));

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
