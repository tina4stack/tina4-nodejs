import type { RouteDefinition } from "@tina4/core";
import type { ModelDefinition, FieldDefinition } from "@tina4/orm";

interface OpenAPISpecInfo {
  title: string;
  version: string;
  description?: string;
  contact?: { name?: string; url?: string; email?: string };
  license?: { name: string; url?: string };
}

interface OpenAPISpec {
  openapi: string;
  info: OpenAPISpecInfo;
  servers?: { url: string }[];
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  tags?: { name: string }[];
}

const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

// ── Configuration registries (v3.13.42) ───────────────────────────
// Process-wide registries for security schemes and reusable component schemas
// declared programmatically (addSecurityScheme / addSchema). Kept module-level so
// app bootstrap can register before any generate() call; resetRegistry() clears
// them (tests). Parity with Python's Swagger.add_security_scheme/add_schema/reset_registry.
const registeredSchemes: Record<string, Record<string, unknown>> = {};
const registeredSchemas: Record<string, Record<string, unknown>> = {};

/**
 * Register a named OpenAPI security scheme (e.g. an oauth2 scheme with scopes,
 * or a custom apiKey). Call at app bootstrap, before generate(). A registered
 * scheme may override the built-in bearerAuth.
 */
export function addSecurityScheme(name: string, definition: Record<string, unknown>): void {
  registeredSchemes[name] = definition;
}

/**
 * Register a reusable component schema, referenceable via meta.requestSchema /
 * meta.responseSchemas or a raw $ref.
 */
export function addSchema(name: string, schema: Record<string, unknown>): void {
  registeredSchemas[name] = schema;
}

/** Clear the security-scheme and schema registries (test helper). */
export function resetRegistry(): void {
  for (const k of Object.keys(registeredSchemes)) delete registeredSchemes[k];
  for (const k of Object.keys(registeredSchemas)) delete registeredSchemas[k];
}

/** Resolve TINA4_SWAGGER_OPENAPI to a concrete version. Default 3.0.3; "3.1"/"3.1.0" -> "3.1.0". */
function resolveOpenApiVersion(): string {
  const v = (process.env.TINA4_SWAGGER_OPENAPI ?? "").trim();
  if (!v) return "3.0.3";
  if (v === "3.1" || v === "3.1.0") return "3.1.0";
  if (v === "3.0" || v === "3.0.3") return "3.0.3";
  return v; // honour an explicit full version verbatim
}

/** Comma-separated env value -> clean list. */
function csv(val: string | undefined): string[] {
  return (val ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Resolve components.securitySchemes from defaults + env + registry. */
function resolveSecuritySchemes(): Record<string, Record<string, unknown>> {
  const bearerFormat = process.env.TINA4_SWAGGER_BEARER_FORMAT ?? "JWT";
  const schemes: Record<string, Record<string, unknown>> = {
    bearerAuth: { type: "http", scheme: "bearer", bearerFormat },
  };
  const apiKeyName = (process.env.TINA4_SWAGGER_API_KEY_NAME ?? "").trim();
  if (apiKeyName.length > 0) {
    const rawIn = process.env.TINA4_SWAGGER_API_KEY_IN ?? "header";
    const apiKeyIn = ["header", "query", "cookie"].includes(rawIn) ? rawIn : "header";
    schemes.apiKeyAuth = { type: "apiKey", name: apiKeyName, in: apiKeyIn };
  }
  // Registered schemes win (let an app override bearerAuth or add oauth2).
  for (const [name, def] of Object.entries(registeredSchemes)) {
    schemes[name] = def;
  }
  return schemes;
}

/**
 * Normalize a meta.security value (+ optional scopes) into an OpenAPI
 * security-requirement list. Mirrors Python's _normalize_security.
 */
function normalizeSecurity(
  value: NonNullable<unknown> | undefined,
  scopes: string[] | undefined
): Array<Record<string, string[]>> {
  if ((value === "public" || value === "none" || value === undefined || value === null) && (!scopes || scopes.length === 0)) {
    return [];
  }
  if (typeof value === "string") {
    return [{ [value]: [...(scopes ?? [])] }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return value.map((req) => normalizeRequirementMap(req as Record<string, string[]>));
  }
  if (value !== null && typeof value === "object") {
    return [normalizeRequirementMap(value as Record<string, string[]>)];
  }
  return [];
}

function normalizeRequirementMap(req: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(req)) out[k] = [...(v ?? [])];
  return out;
}

/**
 * Keep a security-requirement list spec-valid: scopes are allowed only on
 * oauth2/openIdConnect schemes; everything else gets an empty array (OpenAPI
 * requires it). Mirrors Python's _sanitize_security.
 */
function sanitizeSecurity(
  reqs: Array<Record<string, string[]>>,
  schemes: Record<string, Record<string, unknown>>
): Array<Record<string, string[]>> {
  const scopeOk = new Set(["oauth2", "openIdConnect"]);
  return reqs.map((req) => {
    const clean: Record<string, string[]> = {};
    for (const [name, scopes] of Object.entries(req)) {
      const stype = (schemes[name] as Record<string, unknown> | undefined)?.type;
      clean[name] = scopeOk.has(stype as string) ? [...scopes] : [];
    }
    return clean;
  });
}

export function generate(
  routes: RouteDefinition[],
  models: ModelDefinition[] = []
): OpenAPISpec {
  const info: OpenAPISpecInfo = {
    title: process.env.TINA4_SWAGGER_TITLE ?? "Tina4 API",
    version: process.env.TINA4_SWAGGER_VERSION ?? "0.0.1",
    description: process.env.TINA4_SWAGGER_DESCRIPTION ?? "Auto-generated API documentation",
  };

  // Optional contact — email, plus name/url (the interface declares them; they
  // were never populated before). Matches the python SWAGGER_CONTACT_* convention.
  const contactEmail = (process.env.TINA4_SWAGGER_CONTACT_EMAIL ?? "").trim();
  const contactName = (process.env.TINA4_SWAGGER_CONTACT_TEAM ?? "").trim();
  const contactUrl = (process.env.TINA4_SWAGGER_CONTACT_URL ?? "").trim();
  const contact: { name?: string; url?: string; email?: string } = {};
  if (contactName.length > 0) contact.name = contactName;
  if (contactUrl.length > 0) contact.url = contactUrl;
  if (contactEmail.length > 0) contact.email = contactEmail;
  if (Object.keys(contact).length > 0) info.contact = contact;

  // Optional license — accepts a plain SPDX identifier ("MIT", "Apache-2.0")
  // or a "Name|URL" pair. Empty string disables license output entirely.
  const licenseRaw = (process.env.TINA4_SWAGGER_LICENSE ?? "").trim();
  if (licenseRaw.length > 0) {
    const [name, url] = licenseRaw.split("|").map((s) => s.trim());
    info.license = url ? { name, url } : { name };
  }

  const schemes = resolveSecuritySchemes();
  const spec: OpenAPISpec = {
    openapi: resolveOpenApiVersion(),
    info,
    servers: resolveServers(),
    paths: {},
    components: {
      schemas: {},
      // Configurable security schemes (v3.13.42): bearerFormat via env, optional
      // apiKey scheme, plus any programmatically-registered schemes (which may
      // override bearerAuth — e.g. an oauth2 scheme with scopes).
      securitySchemes: schemes,
    },
  };

  // Default scheme secured routes use when no explicit meta.security is set.
  const defaultScheme = process.env.TINA4_SWAGGER_DEFAULT_SCHEME ?? "bearerAuth";

  // Path filters (comma-separated raw-path prefixes).
  const includePrefixes = csv(process.env.TINA4_SWAGGER_INCLUDE);
  const excludePrefixes = csv(process.env.TINA4_SWAGGER_EXCLUDE);

  // Reusable custom schemas referenced by routes via meta.requestSchema/responseSchemas.
  const refSchemas = new Set<string>();

  // Generate schemas from models
  for (const model of models) {
    const schema = modelToSchema(model);
    spec.components!.schemas![model.tableName] = schema;
  }

  const usedTags: string[] = [];
  const seenIds = new Set<string>();

  // Generate paths from routes
  for (const route of routes) {
    if (!isIncludedPath(route.pattern, includePrefixes, excludePrefixes)) continue;
    const openApiPath = patternToOpenAPI(route.pattern);
    const method = route.method.toLowerCase();

    if (!spec.paths[openApiPath]) {
      spec.paths[openApiPath] = {};
    }

    const tags = route.meta?.tags ?? inferTags(route.pattern);
    for (const t of tags) {
      if (!usedTags.includes(t)) usedTags.push(t);
    }

    const operation: Record<string, unknown> = {
      operationId: uniqueOperationId(method, openApiPath, seenIds),
      summary: route.meta?.summary ?? `${route.method} ${route.pattern}`,
      tags,
      responses: route.meta?.responses ?? {
        "200": { description: "Successful response" },
      },
    };

    if (route.meta?.description) operation.description = route.meta.description;
    if (route.meta?.deprecated) operation.deprecated = true;

    // Add path parameters
    const pathParams = extractPathParams(route.pattern);
    if (pathParams.length > 0) {
      operation.parameters = pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }

    // Add query parameters for GET list endpoints
    if (method === "get" && !route.pattern.includes("[id]") && !route.pattern.includes("[...")) {
      const modelName = inferModelFromPath(route.pattern);
      if (modelName && models.some((m) => m.tableName === modelName)) {
        operation.parameters = [
          ...(operation.parameters as unknown[] ?? []),
          { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
          { name: "sort", in: "query", schema: { type: "string" }, description: "Sort fields (prefix with - for descending)" },
        ];
      }
    }

    // Request body — a registered custom schema $ref (meta.requestSchema) wins,
    // else the inferred-from-model body (POST/PUT to a resource), else an
    // example-only body.
    const reqSchemaRef = parseRequestSchema(route.meta?.requestSchema);
    if (reqSchemaRef && (method === "post" || method === "put" || method === "patch")) {
      refSchemas.add(reqSchemaRef.name);
      const media: Record<string, unknown> = {
        schema: { $ref: `#/components/schemas/${reqSchemaRef.name}` },
      };
      if (route.meta?.example !== undefined) media.example = route.meta.example;
      operation.requestBody = {
        content: { [reqSchemaRef.contentType]: media },
      };
    } else if (method === "post" || method === "put") {
      const modelName = inferModelFromPath(route.pattern);
      if (modelName && models.some((m) => m.tableName === modelName)) {
        const media: Record<string, unknown> = {
          schema: { $ref: `#/components/schemas/${modelName}` },
        };
        if (route.meta?.example !== undefined) media.example = route.meta.example;
        operation.requestBody = {
          required: true,
          content: { "application/json": media },
        };

        // Add response schema
        operation.responses = {
          ...(method === "post"
            ? { "201": { description: "Created", content: { "application/json": { schema: { $ref: `#/components/schemas/${modelName}` } } } } }
            : { "200": { description: "Updated", content: { "application/json": { schema: { $ref: `#/components/schemas/${modelName}` } } } } }),
          "422": { description: "Validation failed" },
        };
      } else if (route.meta?.example !== undefined) {
        // Non-model body with an explicit example.
        operation.requestBody = {
          content: { "application/json": { schema: inferSchema(route.meta.example), example: route.meta.example } },
        };
      }
    }

    // Registered response schemas ($ref) — explicit and authoritative, keyed by status.
    const respSchemas = parseResponseSchemas(route.meta?.responseSchemas);
    if (respSchemas.length > 0) {
      const responses = operation.responses as Record<string, unknown>;
      for (const { status, name, isList } of respSchemas) {
        refSchemas.add(name);
        const sref = `#/components/schemas/${name}`;
        const schema = isList ? { type: "array", items: { $ref: sref } } : { $ref: sref };
        responses[status] = {
          description: status.startsWith("2") ? "Successful response" : "Response",
          content: { "application/json": { schema } },
        };
      }
    }

    // Security (v3.13.42) — explicit meta.security wins (empty list = explicitly
    // public); otherwise a secured route gets the default scheme. Scopes are kept
    // valid (only oauth2/openIdConnect carry them).
    const hasExplicitSecurity =
      route.meta?.security !== undefined || (route.meta?.scopes !== undefined && route.meta.scopes.length > 0);
    if (hasExplicitSecurity) {
      const normalized = normalizeSecurity(route.meta?.security, route.meta?.scopes);
      operation.security = normalized.length > 0 ? sanitizeSecurity(normalized, schemes) : [];
      if (normalized.length > 0) {
        const responses = operation.responses as Record<string, unknown>;
        if (!responses["401"]) responses["401"] = { description: "Unauthorized" };
      }
    } else if (routeRequiresAuth(route, method)) {
      operation.security = sanitizeSecurity([{ [defaultScheme]: [] }], schemes);
      const responses = operation.responses as Record<string, unknown>;
      if (!responses["401"]) responses["401"] = { description: "Unauthorized" };
    }

    spec.paths[openApiPath][method] = operation;
  }

  // Registered component schemas referenced via meta.requestSchema/responseSchemas.
  if (refSchemas.size > 0) {
    const schemas = spec.components!.schemas!;
    for (const name of refSchemas) {
      if (name in registeredSchemas && !(name in schemas)) {
        schemas[name] = registeredSchemas[name];
      }
    }
  }

  if (usedTags.length > 0) {
    spec.tags = usedTags.map((name) => ({ name }));
  }

  return spec;
}

function routeRequiresAuth(route: RouteDefinition, method: string): boolean {
  if (route.noAuth) return false;
  if (WRITE_METHODS.has(method)) return true; // secure by default (router parity)
  return route.secure === true;
}

/**
 * Path-filter a raw route pattern. Framework internals (/swagger, /__dev) are
 * ALWAYS excluded; then TINA4_SWAGGER_INCLUDE (allow-list) / _EXCLUDE apply.
 * Mirrors Python's _included.
 */
function isIncludedPath(rawPath: string, include: string[], exclude: string[]): boolean {
  for (const internal of ["/swagger", "/__dev"]) {
    if (rawPath === internal || rawPath.startsWith(internal + "/")) return false;
  }
  if (include.length > 0 && !include.some((p) => rawPath === p || rawPath.startsWith(p))) {
    return false;
  }
  if (exclude.some((p) => rawPath === p || rawPath.startsWith(p))) return false;
  return true;
}

function parseRequestSchema(
  spec: string | { name: string; contentType?: string } | undefined
): { name: string; contentType: string } | null {
  if (spec === undefined) return null;
  if (typeof spec === "string") return { name: spec, contentType: "application/json" };
  return { name: spec.name, contentType: spec.contentType ?? "application/json" };
}

function parseResponseSchemas(
  spec: Record<string, string | { name: string; isList?: boolean }> | undefined
): Array<{ status: string; name: string; isList: boolean }> {
  if (!spec) return [];
  const out: Array<{ status: string; name: string; isList: boolean }> = [];
  for (const [status, value] of Object.entries(spec)) {
    if (typeof value === "string") {
      out.push({ status, name: value, isList: false });
    } else {
      out.push({ status, name: value.name, isList: value.isList === true });
    }
  }
  return out;
}

function resolveServers(): { url: string }[] {
  const raw = (process.env.TINA4_SWAGGER_SERVERS ?? "").trim();
  const urls = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (urls.length > 0) return urls.map((url) => ({ url }));
  const dev = (process.env.SWAGGER_DEV_URL ?? "").trim();
  return dev.length > 0 ? [{ url: dev }] : [{ url: "/" }];
}

function modelToSchema(model: ModelDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, def] of Object.entries(model.fields)) {
    properties[name] = fieldToSchemaProperty(def);
    if (def.required && !def.primaryKey) {
      required.push(name);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function fieldToSchemaProperty(def: FieldDefinition): Record<string, unknown> {
  const prop: Record<string, unknown> = {};

  switch (def.type) {
    case "string":
    case "text":
      prop.type = "string";
      if (def.maxLength) prop.maxLength = def.maxLength;
      if (def.minLength) prop.minLength = def.minLength;
      if (def.pattern) prop.pattern = def.pattern;
      break;
    case "integer":
      prop.type = "integer";
      if (def.min !== undefined) prop.minimum = def.min;
      if (def.max !== undefined) prop.maximum = def.max;
      break;
    case "number":
    case "numeric":
      prop.type = "number";
      if (def.min !== undefined) prop.minimum = def.min;
      if (def.max !== undefined) prop.maximum = def.max;
      break;
    case "boolean":
      prop.type = "boolean";
      break;
    case "datetime":
      prop.type = "string";
      prop.format = "date-time";
      break;
    case "foreignKey":
      // A foreign-key column is an integer reference. Before, it had no case
      // and produced an empty {} schema (audit P2).
      prop.type = "integer";
      break;
    case "json":
      // A JSON document column — an object or array. OpenAPI 3.0 can't express
      // "object OR array" in one type, so advertise the common object shape.
      prop.type = "object";
      break;
    default:
      prop.type = "string";
  }

  if (def.default !== undefined) prop.default = def.default;
  if (def.primaryKey && def.autoIncrement) {
    prop.readOnly = true;
  }

  return prop;
}

function inferSchema(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? inferSchema(value[0]) : {} };
  }
  if (value !== null && typeof value === "object") {
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = inferSchema(v);
    }
    return { type: "object", properties };
  }
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: "string" };
}

function patternToOpenAPI(pattern: string): string {
  return pattern.replace(/\[\.\.\.(\w+)\]/g, "{$1}").replace(/\[(\w+)\]/g, "{$1}");
}

function extractPathParams(pattern: string): string[] {
  const params: string[] = [];
  const regex = /\[(?:\.\.\.)?(\w+)\]/g;
  let match;
  while ((match = regex.exec(pattern)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function inferTags(pattern: string): string[] {
  const parts = pattern.split("/").filter(Boolean);
  // Use the first meaningful segment after /api/ as tag
  const apiIndex = parts.indexOf("api");
  if (apiIndex !== -1 && parts[apiIndex + 1]) {
    return [parts[apiIndex + 1]];
  }
  return parts.length > 0 ? [parts[0]] : ["default"];
}

function inferModelFromPath(pattern: string): string | null {
  const parts = pattern.split("/").filter(Boolean);
  const apiIndex = parts.indexOf("api");
  if (apiIndex === -1 || !parts[apiIndex + 1]) return null;
  const candidate = parts[apiIndex + 1];
  // Only a SIMPLE resource binds a model: /api/<model> or /api/<model>/[id].
  // A deeper nested path (/api/users/[id]/comments) must NOT attach the parent
  // resource's body/schema to the sub-resource endpoint (audit P2).
  const rest = parts.slice(apiIndex + 2);
  if (rest.length === 0) return candidate;
  if (rest.length === 1 && /^[[{]\.{0,3}\w+[\]}]$/.test(rest[0])) return candidate;
  return null;
}

function uniqueOperationId(method: string, openApiPath: string, seen: Set<string>): string {
  const base = (method + openApiPath.replace(/[/{}]/g, "_"))
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  let oid = base;
  let n = 2;
  while (seen.has(oid)) {
    oid = `${base}_${n}`;
    n += 1;
  }
  seen.add(oid);
  return oid;
}
