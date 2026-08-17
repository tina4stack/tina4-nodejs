import type { RouteDefinition } from "../../core/src/index.js";
import type { ModelDefinition, FieldDefinition } from "../../orm/src/index.js";

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

/**
 * Framework-internal route prefixes that are NEVER part of an application's
 * public API document. SHARED across all four frameworks (SWAG-EXCLUSION-NOT-
 * SHARED, ADR-0004) so the exclusion is one rule everywhere, not three
 * mechanisms: the dev tools (/swagger, /__dev), the feedback widget
 * (/__feedback), and the built-in AI/RAG service probes (/ai, /rag, /vision,
 * /embed, /image). This is the ONE thing standing between `/__feedback/*`
 * (genuinely registered into the router by DevAdmin.register -> feedback.ts)
 * and the public document now that generate() reads the LIVE route table per
 * request (SWAG-NODE-FEEDBACK-LEAK) — before this list carried only
 * /swagger + /__dev, so `/__feedback` was excluded only by BOOT ORDERING
 * (swagger's route snapshot predated DevAdmin.register), not by a rule.
 */
const INTERNAL_PREFIXES = ["/swagger", "/__dev", "/__feedback", "/ai", "/rag", "/vision", "/embed", "/image"];

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
  const ssoIssuer = (process.env.TINA4_SSO_ISSUER ?? "").replace(/\/$/, "");
  if (ssoIssuer) {
    schemes.oidc = {
      type: "openIdConnect",
      openIdConnectUrl: `${ssoIssuer}/.well-known/openid-configuration`,
    };
    schemes.ssoSession = { type: "apiKey", in: "cookie", name: "tina4_session" };
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
    // The app's version, defaulting to 1.0.0 — NOT the framework's (Node shipped
    // 0.0.1). description defaults to the empty string, not a canned sentence.
    // Both are the settled cross-framework defaults (parity with the Python
    // master); TINA4_SWAGGER_VERSION / _DESCRIPTION still override.
    version: process.env.TINA4_SWAGGER_VERSION ?? "1.0.0",
    description: process.env.TINA4_SWAGGER_DESCRIPTION ?? "",
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

  // Generate schemas from models, keyed by the model CLASS name ('Item'), which
  // is the type name a generated client wants — never the tableName ('items').
  // `tableToSchema` maps a path-inferred tableName back to that schema key so a
  // POST/PUT request body $ref resolves to the same 'Item' entry.
  const tableToSchema = new Map<string, string>();
  for (const model of models) {
    const schemaKey = schemaNameForModel(model);
    tableToSchema.set(model.tableName, schemaKey);
    spec.components!.schemas![schemaKey] = modelToSchema(model);
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

    // Add path parameters. Each typed token maps to its JSON Schema fragment
    // (int -> integer, uuid -> string+format, slug -> string+pattern, ...) via
    // PARAM_TYPE_SCHEMA below, mirroring the Python master's _PARAM_TYPE_SCHEMA
    // and the router's accepted token set. An unknown token degrades to string
    // rather than dropping the parameter, and the token never reaches the key.
    const pathParams = extractPathParams(route.pattern);
    if (pathParams.length > 0) {
      operation.parameters = pathParams.map(({ name, schema }) => ({
        name,
        in: "path",
        required: true,
        schema,
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
      const schemaKey = modelName ? tableToSchema.get(modelName) : undefined;
      if (schemaKey) {
        const sref = `#/components/schemas/${schemaKey}`;
        const media: Record<string, unknown> = { schema: { $ref: sref } };
        if (route.meta?.example !== undefined) media.example = route.meta.example;
        operation.requestBody = {
          required: true,
          content: { "application/json": media },
        };

        // Response documents 200 with the resource schema — parity with the
        // Python master, which emits ONLY 200 for a model write. The old code
        // stamped an unconditional 422 and a 201 the generator has no way to know
        // a given route returns; both were fiction on a path-inferred write. A
        // route that genuinely answers another code declares it via
        // meta.responses, which is honoured above and never clobbered here.
        if (route.meta?.responses === undefined) {
          operation.responses = {
            "200": { description: "Successful response", content: { "application/json": { schema: { $ref: sref } } } },
          };
        }
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
      const requirements = [{ [defaultScheme]: [] }];
      if (defaultScheme === "bearerAuth" && schemes.ssoSession) requirements.push({ ssoSession: [] });
      operation.security = sanitizeSecurity(requirements, schemes);
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
 * Path-filter a raw route pattern. Framework internals (INTERNAL_PREFIXES)
 * are ALWAYS excluded; then TINA4_SWAGGER_INCLUDE (allow-list) / _EXCLUDE
 * apply. Mirrors the other three frameworks' _included/included?.
 */
function isIncludedPath(rawPath: string, include: string[], exclude: string[]): boolean {
  for (const internal of INTERNAL_PREFIXES) {
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

/**
 * The `components.schemas` key for a model: its CLASS name when carried from
 * discovery (`ModelClass.name`, e.g. `Item`), else a singular PascalCase
 * derivation of the tableName so a raw `{tableName, fields}` still yields a
 * client-friendly type name ('items' -> 'Item').
 */
function schemaNameForModel(model: ModelDefinition): string {
  const explicit = model.className?.trim();
  if (explicit) return explicit;
  return deriveClassName(model.tableName);
}

/** 'items' -> 'Item', 'blog_posts' -> 'BlogPost', 'categories' -> 'Category'. */
function deriveClassName(tableName: string): string {
  return singularize(tableName)
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("") || tableName;
}

/** Best-effort English singularisation for the common plural-table convention. */
function singularize(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return word.slice(0, -3) + "y";
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/ss$/i.test(word)) return word;      // "class"/"address" stay as-is
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
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

/**
 * Path-param type token -> JSON Schema fragment. Mirrors the Python master's
 * `_PARAM_TYPE_SCHEMA` (tina4_python/swagger/__init__.py) and the router's
 * `PARAM_TYPE_PATTERNS`, so the documented contract matches EXACTLY what the
 * router accepts. `int`/`integer` -> integer, `float`/`number` -> number,
 * `uuid` -> string+format, `slug`/`alpha`/`alnum` -> string+pattern, bare/`path`
 * -> string. A token NOT in this table degrades to `{type:"string"}` (see
 * `extractPathParams`) rather than dropping the parameter.
 */
const PARAM_TYPE_SCHEMA: Record<string, Record<string, unknown>> = {
  int: { type: "integer" },
  integer: { type: "integer" },
  float: { type: "number" },
  number: { type: "number" },
  uuid: { type: "string", format: "uuid" },
  slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  alpha: { type: "string", pattern: "^[A-Za-z]+$" },
  alnum: { type: "string", pattern: "^[A-Za-z0-9]+$" },
  path: { type: "string" },
  string: { type: "string" },
};

/**
 * The (name, type) of a single dynamic path segment, or null for a static one.
 *
 * Accepts EVERY shape a route pattern can carry: the brace form `{id}` /
 * `{id:int}` / `{...slug}` (the runtime/programmatic spelling), the file-system
 * form `[id]` / `[...slug]` (route discovery converts these to `{...}` before a
 * route is registered, but `generate()` is public and a caller may hand either),
 * and the Express form `:id`. A catch-all (`...`) carries no type token, so it
 * is always a string.
 */
function segmentParam(segment: string): { name: string; type: string } | null {
  if (segment.startsWith("{") && segment.endsWith("}")) {
    const inner = segment.slice(1, -1);
    if (inner.startsWith("...")) return { name: inner.slice(3), type: "string" };
    const colon = inner.indexOf(":");
    if (colon >= 0) return { name: inner.slice(0, colon), type: inner.slice(colon + 1) };
    return { name: inner, type: "string" };
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    const inner = segment.slice(1, -1);
    return { name: inner.startsWith("...") ? inner.slice(3) : inner, type: "string" };
  }
  if (segment.startsWith(":") && segment.length > 1) {
    return { name: segment.slice(1), type: "string" };
  }
  return null;
}

/**
 * The OpenAPI path key for a route pattern: every dynamic segment collapses to a
 * bare `{name}`, so the type token NEVER leaks into the key (PHP shipped
 * `/api/typed/{id:int}` as the key — invalid, and a mismatch with the declared
 * parameter). File-system `[id]`/`[...slug]`, runtime `{id:int}`/`{...slug}` and
 * Express `:id` all normalise to `{name}`.
 */
function patternToOpenAPI(pattern: string): string {
  return pattern
    .split("/")
    .map((segment) => {
      const p = segmentParam(segment);
      return p ? `{${p.name}}` : segment;
    })
    .join("/");
}

/**
 * Every dynamic path parameter of a route pattern as a `{name, schema}` pair.
 *
 * This once matched only `[id]` - the FILE-SYSTEM spelling - while route
 * discovery had already converted `[id]` to `{id}`, so at runtime the regex ran
 * against `{id}` looking for `[id]` and returned nothing: every operation
 * shipped with no `in: path` parameter, an invalid document (measured against
 * openapi-spec-validator), unconditionally, because the framework registers
 * `/__frond/live/{name}` itself. Beyond that first fix, a TYPED token like
 * `{id:int}` was still dropped (the name-only regex did not match past the
 * colon) and its type leaked into the path key. This segment-based walk resolves
 * both spellings AND the type token, mapping it through PARAM_TYPE_SCHEMA so the
 * documented type matches the route the router compiled.
 */
function extractPathParams(pattern: string): Array<{ name: string; schema: Record<string, unknown> }> {
  const params: Array<{ name: string; schema: Record<string, unknown> }> = [];
  for (const segment of pattern.split("/")) {
    const p = segmentParam(segment);
    if (!p) continue;
    params.push({ name: p.name, schema: { ...(PARAM_TYPE_SCHEMA[p.type] ?? { type: "string" }) } });
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

/**
 * operationId base from method + path, mirroring the Python master's
 * `_operation_id`: strip leading/trailing slashes, turn internal `/` into `_`,
 * drop braces, catch-all `...` and a bare splat `*` -> `wildcard`.
 *
 * Underscores are deliberately NOT collapsed. Collapsing made `/__health` and
 * `/health` both reduce to `get_health`, so one got a `_2` suffix and WHICH one
 * depended on registration order — a generated client's method name flipping
 * between builds. Preserving them yields `get___health` vs `get_health`, two
 * distinct ids straight from the two distinct paths.
 */
function operationIdBase(method: string, openApiPath: string): string {
  const clean = openApiPath
    .replace(/^\/+|\/+$/g, "")   // strip leading/trailing slashes (Python .strip("/"))
    .replace(/\//g, "_")          // internal slash -> underscore
    .replace(/\.\.\./g, "")       // catch-all '...' inside braces -> nothing ({...slug} -> slug)
    .replace(/[{}]/g, "")         // drop braces
    .replace(/\*/g, "wildcard");  // bare splat -> wildcard
  return clean ? `${method}_${clean}` : method;
}

function uniqueOperationId(method: string, openApiPath: string, seen: Set<string>): string {
  const base = operationIdBase(method, openApiPath);
  let oid = base;
  let n = 2;
  while (seen.has(oid)) {
    oid = `${base}_${n}`;
    n += 1;
  }
  seen.add(oid);
  return oid;
}
