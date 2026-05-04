import type { RouteDefinition } from "@tina4/core";
import type { ModelDefinition, FieldDefinition } from "@tina4/orm";

interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

export function generate(
  routes: RouteDefinition[],
  models: ModelDefinition[] = []
): OpenAPISpec {
  const spec: OpenAPISpec = {
    openapi: "3.0.3",
    info: {
      title: process.env.TINA4_SWAGGER_TITLE ?? "Tina4 API",
      version: process.env.TINA4_SWAGGER_VERSION ?? "0.0.1",
      description: process.env.TINA4_SWAGGER_DESCRIPTION ?? "Auto-generated API documentation",
    },
    paths: {},
    components: { schemas: {} },
  };

  // Generate schemas from models
  for (const model of models) {
    const schema = modelToSchema(model);
    spec.components!.schemas![model.tableName] = schema;
  }

  // Generate paths from routes
  for (const route of routes) {
    const openApiPath = patternToOpenAPI(route.pattern);
    const method = route.method.toLowerCase();

    if (!spec.paths[openApiPath]) {
      spec.paths[openApiPath] = {};
    }

    const operation: Record<string, unknown> = {
      summary: route.meta?.summary ?? `${route.method} ${route.pattern}`,
      tags: route.meta?.tags ?? inferTags(route.pattern),
      responses: route.meta?.responses ?? {
        "200": { description: "Successful response" },
      },
    };

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
        operation.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${modelName}` },
            },
          },
        };

        // Add response schema
        operation.responses = {
          ...(method === "post"
            ? { "201": { description: "Created", content: { "application/json": { schema: { $ref: `#/components/schemas/${modelName}` } } } } }
            : { "200": { description: "Updated", content: { "application/json": { schema: { $ref: `#/components/schemas/${modelName}` } } } } }),
          "422": { description: "Validation failed" },
        };
      }
    }

    spec.paths[openApiPath][method] = operation;
  }

  return spec;
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
  }

  if (def.primaryKey && def.autoIncrement) {
    prop.readOnly = true;
  }

  return prop;
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
  if (apiIndex !== -1 && parts[apiIndex + 1]) {
    return parts[apiIndex + 1];
  }
  return null;
}
