/**
 * Tina4 WSDL/SOAP — SOAP 1.1 / WSDL 1.1 service base class.
 *
 * Auto-generates WSDL definitions and handles SOAP XML requests.
 * Zero external dependencies — uses simple string parsing for XML.
 *
 * Matches the PHP reference implementation (Tina4\WSDL).
 *
 *   import { WSDLService, WSDLOp } from "@tina4/core";
 *
 *   class Calculator extends WSDLService {
 *     serviceName = "Calculator";
 *     serviceUrl = "/api/calculator";
 *
 *     @WSDLOp({ output: { Result: "int" } })
 *     async Add(a: number, b: number): Promise<Record<string, unknown>> {
 *       return { Result: a + b };
 *     }
 *   }
 */

// ── Types ────────────────────────────────────────────────────

export interface WSDLOperation {
  name: string;
  description?: string;
  input?: Record<string, string>;   // param name -> type
  output?: Record<string, string>;  // return name -> type
}

interface WSDLOpConfig {
  description?: string;
  input?: Record<string, string>;
  output?: Record<string, string>;
}

// ── Namespace constants ──────────────────────────────────────

const NS_SOAP = "http://schemas.xmlsoap.org/wsdl/soap/";
const NS_WSDL = "http://schemas.xmlsoap.org/wsdl/";
const NS_XSD = "http://www.w3.org/2001/XMLSchema";
const NS_SOAP_ENV = "http://schemas.xmlsoap.org/soap/envelope/";

/** TypeScript/JavaScript type name to XSD type mapping. */
const TYPE_MAP: Record<string, string> = {
  int: "xsd:int",
  integer: "xsd:int",
  float: "xsd:float",
  double: "xsd:double",
  number: "xsd:double",
  numeric: "xsd:double",
  string: "xsd:string",
  bool: "xsd:boolean",
  boolean: "xsd:boolean",
};

// ── XML helpers ──────────────────────────────────────────────

/**
 * Escape special XML characters.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Extract text content from an XML element by tag name (simple string parser).
 * Returns the text content of the first matching element, or null.
 */
function extractElement(xml: string, tagName: string): string | null {
  // Try with namespace prefix variations
  const patterns = [
    new RegExp(`<(?:[a-zA-Z0-9]+:)?${tagName}[^>]*>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tagName}>`, "i"),
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "i"),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Extract all direct child elements with their tag names and text content.
 * Returns an array of { name, value } pairs.
 */
function extractChildren(xml: string): Array<{ name: string; value: string }> {
  const results: Array<{ name: string; value: string }> = [];
  // Match opening tags, capturing name (strip namespace prefix) and content
  const pattern = /<(?:[a-zA-Z0-9]+:)?([a-zA-Z0-9_]+)[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?(\1)[^>]*>/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    results.push({ name: match[1], value: match[2].trim() });
  }

  return results;
}

/**
 * Extract the SOAP Body content from a SOAP envelope.
 */
function extractSoapBody(xml: string): string | null {
  return extractElement(xml, "Body");
}

/**
 * Extract the operation element from the SOAP body.
 * Returns { name, content } or null.
 */
function extractOperation(bodyXml: string): { name: string; content: string } | null {
  // The first child element of Body is the operation
  const match = bodyXml.match(/<(?:[a-zA-Z0-9]+:)?([a-zA-Z0-9_]+)[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?\1[^>]*>/i);
  if (match) {
    return { name: match[1], content: match[2] };
  }
  return null;
}

// ── Metadata storage ─────────────────────────────────────────

/** Symbol key for storing operation metadata on class prototypes. */
const WSDL_OPS_KEY = Symbol("wsdl_operations");

/**
 * Decorator function for marking methods as WSDL operations.
 *
 *   @WSDLOp({ description: "Add two numbers", input: { a: "int", b: "int" }, output: { Result: "int" } })
 *   async Add(a: number, b: number): Promise<Record<string, unknown>> { ... }
 */
export function WSDLOp(config?: WSDLOpConfig) {
  return function (_target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    // Store metadata on the method itself
    const op: WSDLOperation = {
      name: propertyKey,
      description: config?.description,
      input: config?.input,
      output: config?.output,
    };

    if (!descriptor.value._wsdlOp) {
      descriptor.value._wsdlOp = op;
    }

    return descriptor;
  };
}

// ── WSDLService ──────────────────────────────────────────────

export abstract class WSDLService {
  abstract serviceName: string;
  abstract serviceUrl: string;

  protected namespace: string = "http://tina4.com/wsdl";

  /**
   * Lifecycle hook: called before operation invocation.
   * Override to validate, log, or modify the incoming request.
   */
  protected onRequest(_request: unknown): void {
    // no-op — override in subclass
  }

  /**
   * Lifecycle hook: called after operation returns.
   * Override to transform, audit, or enrich the result.
   * Must return the (possibly modified) result.
   */
  protected onResult(result: Record<string, unknown>): Record<string, unknown> {
    return result;
  }

  /** Discovered operations (populated on first use). */
  private _operations: Map<string, WSDLOperation> | null = null;

  /**
   * Discover operations by scanning for methods with _wsdlOp metadata.
   */
  private discoverOperations(): Map<string, WSDLOperation> {
    if (this._operations) return this._operations;

    this._operations = new Map();

    // Walk the prototype chain to find decorated methods
    let proto = Object.getPrototypeOf(this);
    while (proto && proto !== WSDLService.prototype && proto !== Object.prototype) {
      const names = Object.getOwnPropertyNames(proto);
      for (const name of names) {
        if (name === "constructor") continue;
        try {
          const method = (this as Record<string, unknown>)[name];
          if (typeof method === "function" && (method as unknown as Record<string, unknown>)._wsdlOp) {
            const op = (method as unknown as Record<string, unknown>)._wsdlOp as WSDLOperation;
            if (!this._operations.has(name)) {
              this._operations.set(name, op);
            }
          }
        } catch {
          // skip non-accessible properties
        }
      }
      proto = Object.getPrototypeOf(proto);
    }

    return this._operations;
  }

  /**
   * Map a type name to an XSD type string.
   */
  private typeToXsd(typeName: string): string {
    return TYPE_MAP[typeName] ?? "xsd:string";
  }

  /**
   * Convert a string value from XML to the target type.
   */
  private convertValue(value: string, typeName: string): unknown {
    switch (typeName) {
      case "int":
      case "integer":
        return parseInt(value, 10);
      case "float":
      case "double":
      case "number":
      case "numeric":
        return parseFloat(value);
      case "bool":
      case "boolean":
        return ["true", "1", "yes"].includes(value.toLowerCase());
      default:
        return value;
    }
  }

  /**
   * Generate WSDL 1.1 XML document.
   */
  generateWSDL(endpointUrl?: string): string {
    const ops = this.discoverOperations();
    const tns = `urn:${this.serviceName}`;
    const url = endpointUrl ?? this.serviceUrl;
    const parts: string[] = [];

    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<definitions name="${this.serviceName}"`);
    parts.push(`  targetNamespace="${tns}"`);
    parts.push(`  xmlns:tns="${tns}"`);
    parts.push(`  xmlns:soap="${NS_SOAP}"`);
    parts.push(`  xmlns:xsd="${NS_XSD}"`);
    parts.push(`  xmlns="${NS_WSDL}">`);
    parts.push("");

    // Types
    parts.push("  <types>");
    parts.push(`    <xsd:schema targetNamespace="${tns}">`);

    for (const [opName, op] of ops) {
      // Request element
      parts.push(`      <xsd:element name="${opName}">`);
      parts.push("        <xsd:complexType>");
      parts.push("          <xsd:sequence>");

      if (op.input) {
        for (const [paramName, paramType] of Object.entries(op.input)) {
          const xsdType = this.typeToXsd(paramType);
          parts.push(`            <xsd:element name="${paramName}" type="${xsdType}"/>`);
        }
      }

      parts.push("          </xsd:sequence>");
      parts.push("        </xsd:complexType>");
      parts.push(`      </xsd:element>`);

      // Response element
      parts.push(`      <xsd:element name="${opName}Response">`);
      parts.push("        <xsd:complexType>");
      parts.push("          <xsd:sequence>");

      if (op.output) {
        for (const [retName, retType] of Object.entries(op.output)) {
          const xsdType = this.typeToXsd(retType);
          parts.push(`            <xsd:element name="${retName}" type="${xsdType}"/>`);
        }
      }

      parts.push("          </xsd:sequence>");
      parts.push("        </xsd:complexType>");
      parts.push(`      </xsd:element>`);
    }

    parts.push("    </xsd:schema>");
    parts.push("  </types>");
    parts.push("");

    // Messages
    for (const [opName] of ops) {
      parts.push(`  <message name="${opName}Input">`);
      parts.push(`    <part name="parameters" element="tns:${opName}"/>`);
      parts.push("  </message>");
      parts.push(`  <message name="${opName}Output">`);
      parts.push(`    <part name="parameters" element="tns:${opName}Response"/>`);
      parts.push("  </message>");
    }
    parts.push("");

    // PortType
    parts.push(`  <portType name="${this.serviceName}PortType">`);
    for (const [opName] of ops) {
      parts.push(`    <operation name="${opName}">`);
      parts.push(`      <input message="tns:${opName}Input"/>`);
      parts.push(`      <output message="tns:${opName}Output"/>`);
      parts.push("    </operation>");
    }
    parts.push("  </portType>");
    parts.push("");

    // Binding
    parts.push(`  <binding name="${this.serviceName}Binding" type="tns:${this.serviceName}PortType">`);
    parts.push('    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>');
    for (const [opName] of ops) {
      parts.push(`    <operation name="${opName}">`);
      parts.push(`      <soap:operation soapAction="${tns}/${opName}"/>`);
      parts.push('      <input><soap:body use="literal"/></input>');
      parts.push('      <output><soap:body use="literal"/></output>');
      parts.push("    </operation>");
    }
    parts.push("  </binding>");
    parts.push("");

    // Service
    parts.push(`  <service name="${this.serviceName}">`);
    parts.push(`    <port name="${this.serviceName}Port" binding="tns:${this.serviceName}Binding">`);
    parts.push(`      <soap:address location="${url}"/>`);
    parts.push("    </port>");
    parts.push("  </service>");

    parts.push("</definitions>");

    return parts.join("\n");
  }

  /**
   * Handle incoming SOAP request (parse XML, dispatch to method, return SOAP response).
   */
  async handleRequest(soapXml: string): Promise<string> {
    const ops = this.discoverOperations();

    // Parse SOAP body
    const body = extractSoapBody(soapXml);
    if (!body) {
      return this.soapFault("Client", "Missing SOAP Body");
    }

    // Extract operation
    const operation = extractOperation(body);
    if (!operation) {
      return this.soapFault("Client", "Empty SOAP Body");
    }

    const opName = operation.name;
    const opMeta = ops.get(opName);
    if (!opMeta) {
      return this.soapFault("Client", `Unknown operation: ${opName}`);
    }

    // Check the method exists on this instance
    const method = (this as Record<string, unknown>)[opName];
    if (typeof method !== "function") {
      return this.soapFault("Client", `Operation not implemented: ${opName}`);
    }

    // Extract parameters from the operation element
    const children = extractChildren(operation.content);
    const params: unknown[] = [];

    if (opMeta.input) {
      for (const [paramName, paramType] of Object.entries(opMeta.input)) {
        const child = children.find((c) => c.name === paramName);
        if (child) {
          params.push(this.convertValue(child.value, paramType));
        } else {
          params.push(null);
        }
      }
    }

    // Lifecycle hook: before invocation
    this.onRequest(soapXml);

    // Invoke the method
    try {
      const rawResult = await (method as (...args: unknown[]) => Promise<unknown>).call(this, ...params);
      // Lifecycle hook: after invocation — allow result transformation
      const result = this.onResult(rawResult as Record<string, unknown>);
      return this.soapResponse(opName, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return this.soapFault("Server", errMsg);
    }
  }

  /**
   * Register this service's routes on a router.
   * GET /service-url?wsdl -> WSDL XML
   * POST /service-url -> Handle SOAP request
   */
  register(router: {
    addRoute?: (method: string, path: string, handler: (req: unknown, res: unknown) => void) => void;
  }): void {
    if (!router.addRoute) {
      // Try to use the router as an object with get/post methods
      const r = router as Record<string, unknown>;

      // Register GET for WSDL
      if (typeof r.get === "function") {
        (r.get as Function)(this.serviceUrl, (req: Record<string, unknown>, res: Record<string, unknown>) => {
          this.handleGetRequest(req, res);
        });
      }

      // Register POST for SOAP
      if (typeof r.post === "function") {
        (r.post as Function)(this.serviceUrl, async (req: Record<string, unknown>, res: Record<string, unknown>) => {
          await this.handlePostRequest(req, res);
        });
      }

      return;
    }

    // Use addRoute if available
    router.addRoute("GET", this.serviceUrl, (req, res) => {
      this.handleGetRequest(req as Record<string, unknown>, res as Record<string, unknown>);
    });

    router.addRoute("POST", this.serviceUrl, async (req, res) => {
      await this.handlePostRequest(req as Record<string, unknown>, res as Record<string, unknown>);
    });
  }

  /**
   * Handle GET request — return WSDL XML.
   */
  private handleGetRequest(req: Record<string, unknown>, res: Record<string, unknown>): void {
    // Infer endpoint URL from request if possible
    let endpointUrl = this.serviceUrl;
    if (req.headers && typeof req.headers === "object") {
      const headers = req.headers as Record<string, string>;
      const host = headers.host ?? "localhost";
      const protocol = headers["x-forwarded-proto"] ?? "http";
      endpointUrl = `${protocol}://${host}${this.serviceUrl}`;
    }

    const wsdl = this.generateWSDL(endpointUrl);

    if (typeof res.send === "function") {
      // Set content type if possible
      if (typeof res.setHeader === "function") {
        (res.setHeader as Function)("Content-Type", "text/xml; charset=UTF-8");
      }
      (res.send as Function)(wsdl);
    } else if (typeof res.end === "function") {
      if (typeof res.writeHead === "function") {
        (res.writeHead as Function)(200, { "Content-Type": "text/xml; charset=UTF-8" });
      }
      (res.end as Function)(wsdl);
    }
  }

  /**
   * Handle POST request — process SOAP XML.
   */
  private async handlePostRequest(req: Record<string, unknown>, res: Record<string, unknown>): Promise<void> {
    let xmlBody = "";

    // Try to get body from request object
    if (typeof req.rawBody === "string") {
      xmlBody = req.rawBody;
    } else if (typeof req.body === "string") {
      xmlBody = req.body;
    } else if (typeof req.body === "object" && req.body !== null) {
      xmlBody = JSON.stringify(req.body);
    }

    if (!xmlBody) {
      const fault = this.soapFault("Client", "Empty request body");
      if (typeof res.send === "function") {
        if (typeof res.status === "function") (res.status as Function)(400);
        if (typeof res.setHeader === "function") {
          (res.setHeader as Function)("Content-Type", "text/xml; charset=UTF-8");
        }
        (res.send as Function)(fault);
      }
      return;
    }

    const soapResponse = await this.handleRequest(xmlBody);

    if (typeof res.send === "function") {
      if (typeof res.setHeader === "function") {
        (res.setHeader as Function)("Content-Type", "text/xml; charset=UTF-8");
      }
      (res.send as Function)(soapResponse);
    } else if (typeof res.end === "function") {
      if (typeof res.writeHead === "function") {
        (res.writeHead as Function)(200, { "Content-Type": "text/xml; charset=UTF-8" });
      }
      (res.end as Function)(soapResponse);
    }
  }

  /**
   * Build a SOAP response XML envelope.
   */
  private soapResponse(opName: string, result: Record<string, unknown>): string {
    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(`<soap:Envelope xmlns:soap="${NS_SOAP_ENV}">`);
    parts.push("<soap:Body>");
    parts.push(`<${opName}Response>`);

    if (result && typeof result === "object") {
      for (const [key, value] of Object.entries(result)) {
        if (value === null || value === undefined) {
          parts.push(`<${key} xsi:nil="true" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`);
        } else if (Array.isArray(value)) {
          for (const item of value) {
            parts.push(`<${key}>${escapeXml(String(item))}</${key}>`);
          }
        } else if (typeof value === "boolean") {
          parts.push(`<${key}>${value ? "true" : "false"}</${key}>`);
        } else {
          parts.push(`<${key}>${escapeXml(String(value))}</${key}>`);
        }
      }
    }

    parts.push(`</${opName}Response>`);
    parts.push("</soap:Body>");
    parts.push("</soap:Envelope>");

    return parts.join("\n");
  }

  /**
   * Build a SOAP fault response XML.
   */
  private soapFault(code: string, message: string): string {
    return '<?xml version="1.0" encoding="UTF-8"?>'
      + `<soap:Envelope xmlns:soap="${NS_SOAP_ENV}">`
      + "<soap:Body>"
      + "<soap:Fault>"
      + `<faultcode>${code}</faultcode>`
      + `<faultstring>${escapeXml(message)}</faultstring>`
      + "</soap:Fault>"
      + "</soap:Body>"
      + "</soap:Envelope>";
  }
}
