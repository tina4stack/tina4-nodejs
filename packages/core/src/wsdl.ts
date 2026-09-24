/**
 * Tina4 WSDL/SOAP — SOAP 1.1 / WSDL 1.1 service base class.
 *
 * Auto-generates WSDL definitions and handles SOAP XML requests.
 * Zero external dependencies — uses simple string parsing for XML.
 *
 * Matches the PHP reference implementation (Tina4\WSDL).
 *
 *   import { WSDLService, WSDLOperation } from "@tina4/core";
 *
 *   class Calculator extends WSDLService {
 *     serviceName = "Calculator";
 *     serviceUrl = "/api/calculator";
 *
 *     @WSDLOperation({ output: { Result: "int" } })
 *     async Add(a: number, b: number): Promise<Record<string, unknown>> {
 *       return { Result: a + b };
 *     }
 *   }
 */

import { Log } from "./logger.js";
import { isDebugMode } from "./errorOverlay.js";

// ── Types ────────────────────────────────────────────────────

export interface WSDLOperationMeta {
  name: string;
  description?: string;
  input?: Record<string, string>;   // param name -> type
  output?: Record<string, string>;  // return name -> type
}

interface WSDLOperationConfig {
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

// ── Minimal zero-dep XML parser ──────────────────────────────
// A small well-formedness-checking parser, enough for a SOAP envelope: it
// matches start and end tags, decodes the five predefined entities, decimal
// and hexadecimal character references and CDATA, skips comments and
// processing instructions, and refuses anything else (an undefined entity, a
// bare "&", a mismatched tag, a second root) the way Python's ElementTree
// does, so the handler can answer "Malformed XML" exactly where the reference
// does. Namespace prefixes are stripped to the local name. DOCTYPE is refused
// before this parser ever runs (see handle()).

interface XmlElement {
  /** Local name, prefix stripped ("soap:Body" -> "Body"). */
  name: string;
  /** Qualified name as written, used to match the end tag. */
  qualifiedName: string;
  children: XmlElement[];
  /** Text before the first child element - ElementTree's `.text`. */
  text: string;
}

class MalformedXmlError extends Error {}

function malformed(): never {
  throw new MalformedXmlError("Malformed XML");
}

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
};

/** A code point the XML 1.0 Char production allows. */
function isXmlCharacter(codePoint: number): boolean {
  return codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
    || (codePoint >= 0x20 && codePoint <= 0xd7ff)
    || (codePoint >= 0xe000 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
}

/** Any character XML 1.0 forbids (NUL, most C0 controls, U+FFFE/U+FFFF, a lone surrogate). */
const ILLEGAL_XML_CHARACTER = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*)?(;)?/g, (_whole, reference?: string, semicolon?: string) => {
    if (!reference || !semicolon) malformed();
    if (reference.startsWith("#")) {
      const codePoint = reference[1] === "x" ? parseInt(reference.slice(2), 16) : parseInt(reference.slice(1), 10);
      if (!isXmlCharacter(codePoint)) malformed();
      return String.fromCodePoint(codePoint);
    }
    const value = PREDEFINED_ENTITIES[reference];
    if (value === undefined) malformed();
    return value;
  });
}

const XML_NAME = `[^\\s/<>="'&!?]+`;
const START_TAG = new RegExp(`<(${XML_NAME})((?:\\s+${XML_NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, "y");
const END_TAG = new RegExp(`</(${XML_NAME})\\s*>`, "y");
const ATTRIBUTE_VALUE = /=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

function parseXmlDocument(xml: string): XmlElement {
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let position = 0;

  const addText = (text: string): void => {
    const current = stack[stack.length - 1];
    if (current.children.length === 0) current.text += text;
  };

  while (position < xml.length) {
    const nextTag = xml.indexOf("<", position);
    const textEnd = nextTag === -1 ? xml.length : nextTag;
    if (textEnd > position) {
      const raw = xml.slice(position, textEnd);
      if (stack.length > 0) addText(decodeEntities(raw));
      else if (raw.trim() !== "") malformed(); // text outside the root element
      position = textEnd;
      if (nextTag === -1) break;
    }

    if (xml.startsWith("<!--", position)) {
      const close = xml.indexOf("-->", position + 4);
      if (close === -1) malformed();
      position = close + 3;
    } else if (xml.startsWith("<![CDATA[", position)) {
      const close = xml.indexOf("]]>", position + 9);
      if (close === -1 || stack.length === 0) malformed();
      addText(xml.slice(position + 9, close));
      position = close + 3;
    } else if (xml.startsWith("<?", position)) {
      const close = xml.indexOf("?>", position + 2);
      if (close === -1) malformed();
      const target = xml.slice(position + 2, close).split(/\s/, 1)[0];
      // The XML declaration is only legal as the very first thing in the document.
      if (target.toLowerCase() === "xml" && position !== 0) malformed();
      position = close + 2;
    } else if (xml.startsWith("<!", position)) {
      malformed(); // any other declaration; DOCTYPE was refused before parsing
    } else if (xml.startsWith("</", position)) {
      END_TAG.lastIndex = position;
      const match = END_TAG.exec(xml);
      const open = stack.pop();
      if (!match || !open || open.qualifiedName !== match[1]) malformed();
      position = END_TAG.lastIndex;
    } else {
      START_TAG.lastIndex = position;
      const match = START_TAG.exec(xml);
      if (!match || (stack.length === 0 && root !== null)) malformed(); // bad tag, or a second root
      for (const attribute of match[2].matchAll(ATTRIBUTE_VALUE)) decodeEntities(attribute[1] ?? attribute[2]);
      const qualifiedName = match[1];
      const element: XmlElement = {
        name: qualifiedName.slice(qualifiedName.indexOf(":") + 1),
        qualifiedName,
        children: [],
        text: "",
      };
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      else root = element;
      if (match[3] !== "/") stack.push(element);
      position = START_TAG.lastIndex;
    }
  }

  if (root === null || stack.length > 0) malformed();
  return root;
}

/** The encoding named in the XML declaration, when the document opens with one. */
const XML_DECLARED_ENCODING = /^<\?xml\s[^>]*?\bencoding\s*=\s*(["'])(.*?)\1/;

/**
 * Turn the request body into text, refusing anything that is not UTF-8 XML
 * BEFORE any parse: bytes that are not valid UTF-8, a byte-order mark (a
 * UTF-16 body starts with one), a character XML forbids (the NULs a UTF-16
 * body leaves behind once decoded as UTF-8), or an XML declaration naming an
 * encoding other than UTF-8. A DOCTYPE hidden in UTF-16 or UTF-7 is therefore
 * refused here, never parsed.
 */
function decodeSoapBody(body: string | Uint8Array): string {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      malformed();
    }
  }
  if (text.startsWith("\uFEFF") || ILLEGAL_XML_CHARACTER.test(text)) malformed();
  // The body IS UTF-8, so a declaration naming any other encoding (UTF-7,
  // UTF-16, ISO-8859-1, even "UTF8") is refused rather than trusted: a parser
  // that honours it would read a different document from the one checked here.
  const declaredEncoding = XML_DECLARED_ENCODING.exec(text);
  if (declaredEncoding && declaredEncoding[2].toUpperCase() !== "UTF-8") malformed();
  return text;
}

// ── Metadata storage ─────────────────────────────────────────

/**
 * Decorator function for marking methods as WSDL operations.
 *
 *   @WSDLOperation({ description: "Add two numbers", input: { a: "int", b: "int" }, output: { Result: "int" } })
 *   async Add(a: number, b: number): Promise<Record<string, unknown>> { ... }
 *
 * Works under both decorator flavours: TC39 standard decorators (what tsx and
 * esbuild compile by default: `(method, context)`) and TypeScript's
 * experimentalDecorators (`(prototype, name, descriptor)`).
 */
export function WSDLOperation(config?: WSDLOperationConfig) {
  return function (
    target: unknown,
    context: string | symbol | { name: string | symbol },
    descriptor?: PropertyDescriptor,
  ): PropertyDescriptor | undefined {
    const method = (descriptor ? descriptor.value : target) as { _wsdlOp?: WSDLOperationMeta };
    const name = typeof context === "object" ? context.name : context;
    // Store metadata on the method itself
    method._wsdlOp ??= {
      name: String(name),
      description: config?.description,
      input: config?.input,
      output: config?.output,
    };
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
  private _operations: Map<string, WSDLOperationMeta> | null = null;

  /**
   * Discover operations by scanning for methods with _wsdlOp metadata.
   */
  private discoverOperations(): Map<string, WSDLOperationMeta> {
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
            const op = (method as unknown as Record<string, unknown>)._wsdlOp as WSDLOperationMeta;
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
      case "integer": {
        // Match Python's int(value) — a non-numeric value RAISES rather than
        // silently yielding NaN. The thrown Error is caught in handle() and
        // becomes a Server fault.
        const n = parseInt(value, 10);
        if (Number.isNaN(n)) {
          throw new Error(`invalid integer value: ${JSON.stringify(value)}`);
        }
        return n;
      }
      case "float":
      case "double":
      case "number":
      case "numeric": {
        // Match Python's float(value) — non-numeric raises (→ Server fault).
        const f = parseFloat(value);
        if (Number.isNaN(f)) {
          throw new Error(`invalid numeric value: ${JSON.stringify(value)}`);
        }
        return f;
      }
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
  async handle(soapXml: string | Uint8Array = ""): Promise<string> {
    const ops = this.discoverOperations();

    // Bytes that are not UTF-8 XML (a UTF-16 body, a byte-order mark) are
    // refused before anything looks inside them.
    let xml: string;
    try {
      xml = decodeSoapBody(soapXml);
    } catch {
      return this.soapFault("Client", "Malformed XML");
    }

    // SOAP 1.1 (§3) forbids a Document Type Declaration in a SOAP message.
    // Rejecting any DOCTYPE/DTD up front — BEFORE the body is parsed — also
    // closes the XML entity-expansion (billion-laughs) and external-entity
    // (XXE) attack surface regardless of parser internals. The operation
    // never runs.
    if (/<!DOCTYPE/i.test(xml)) {
      return this.soapFault("Client", "DOCTYPE declarations are not allowed in SOAP messages");
    }

    let envelope: XmlElement;
    try {
      envelope = parseXmlDocument(xml);
    } catch {
      return this.soapFault("Client", "Malformed XML");
    }

    // The Body is a direct child of the envelope; its first child is the operation.
    const body = envelope.children.find((child) => child.name === "Body");
    if (!body) {
      return this.soapFault("Client", "Missing SOAP Body");
    }

    const operation = body.children[0];
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

    // Lifecycle hook: before invocation
    this.onRequest(soapXml);

    // Invoke the method. Parameter conversion runs INSIDE the try so a
    // non-numeric value for an int/float param (convertValue throws, matching
    // Python's int()/float() raise) becomes a Server fault — not a silent NaN.
    try {
      // Extract parameters from the operation element's children
      const params: unknown[] = [];

      if (opMeta.input) {
        for (const [paramName, paramType] of Object.entries(opMeta.input)) {
          const child = operation.children.find((c) => c.name === paramName);
          if (child) {
            params.push(this.convertValue(child.text, paramType));
          } else {
            params.push(null);
          }
        }
      }

      const rawResult = await (method as (...args: unknown[]) => Promise<unknown>).call(this, ...params);
      // Lifecycle hook: after invocation — allow result transformation
      const result = this.onResult(rawResult as Record<string, unknown>);
      return this.soapResponse(opName, result);
    } catch (err) {
      // Log the real cause, but only leak the detail to the client in debug
      // mode — a resolver exception can carry internal state (DB credentials,
      // file paths) that must not reach a SOAP client.
      const errMsg = err instanceof Error ? err.message : String(err);
      Log.error(`WSDL operation '${opName}' failed: ${errMsg}`);
      const detail = isDebugMode() ? errMsg : "Internal server error";
      return this.soapFault("Server", detail);
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
    let xmlBody: string | Uint8Array = "";

    // Try to get body from request object (raw bytes are checked for UTF-8 in handle())
    if (typeof req.rawBody === "string" || req.rawBody instanceof Uint8Array) {
      xmlBody = req.rawBody;
    } else if (typeof req.body === "string" || req.body instanceof Uint8Array) {
      xmlBody = req.body;
    } else if (typeof req.body === "object" && req.body !== null) {
      xmlBody = JSON.stringify(req.body);
    }

    if (xmlBody.length === 0) {
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

    const soapResponse = await this.handle(xmlBody);

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
