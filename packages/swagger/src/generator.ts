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

  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info,
    servers: resolveServers(),
    paths: {},
    components: {
      schemas: {},
      // bearerAuth was never defined before — secured routes were documented
      // identically to public ones (audit P1). Define it once and reference it.
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };

  // Generate schemas from models
  for (const model of models) {
    const schema = modelToSchema(model);
    spec.components!.schemas![model.tableName] = schema;
  }

  const usedTags: string[] = [];
  const seenIds = new Set<string>();

  // Generate paths from routes
  for (const route of routes) {
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

    // Add request body for POST/PUT
    if (method === "post" || method === "put") {
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

    // Security — a secured route emits operation.security + 401. Mirrors the
    // router's enforcement (writes secure by default unless noAuth; GET secure
    // only when marked). Before, no route ever got a security requirement.
    if (routeRequiresAuth(route, method)) {
      operation.security = [{ bearerAuth: [] }];
      const responses = operation.responses as Record<string, unknown>;
      if (!responses["401"]) responses["401"] = { description: "Unauthorized" };
    }

    spec.paths[openApiPath][method] = operation;
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
