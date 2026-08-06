/**
 * Every {name} in a path must have a matching path parameter, or the document
 * is not valid OpenAPI.
 *
 * MEASURED 2026-08-06 with openapi-spec-validator against the document fetched
 * from a real server. Python, PHP and Ruby validated. Node did not:
 *
 *     Path parameter 'name' for 'get' in '/__frond/live/{name}' was not resolved
 *     Path parameter 'id'   for 'get' in '/api/items/{id}'      was not resolved
 *
 * Unconditional. `/__frond/live/{name}` is registered by the FRAMEWORK, so a
 * Node app with zero user routes already published an invalid spec, and every
 * generated client and every spec-validating gateway saw it.
 *
 * ROOT CAUSE: extractPathParams matched the FILE-SYSTEM spelling, `[id]`, but
 * route discovery converts `[id]` directories to `{id}` URL patterns before
 * the route reaches the router. So the regex ran against `{id}` looking for
 * `[id]` and found nothing, on every route, forever. The path KEY came out
 * right, which is why this looked fine in the rendered UI.
 *
 * No mocks: the real Router and the real generator.
 */
import { describe, it, expect } from "vitest";
import { generate } from "../packages/swagger/src/generator.ts";
import type { RouteDefinition } from "../packages/core/src/types.ts";

interface Param {
  name: string;
  in: string;
  required?: boolean;
  schema?: { type?: string };
}

function pathParamsFor(spec: any, path: string, verb: string): Param[] {
  const op = spec?.paths?.[path]?.[verb];
  return ((op?.parameters ?? []) as Param[]).filter((p) => p.in === "path");
}

/**
 * Patterns are written the way ROUTE DISCOVERY produces them.
 *
 * routeDiscovery converts the file-system spelling to the URL spelling before
 * a route is ever registered - its own comment says "File system uses [id]
 * notation, but URL patterns use {id} to match Python". The existing
 * swagger.test.ts hand-feeds "/api/users/[id]", a shape the framework never
 * produces at runtime, which is exactly why it passed while every real
 * document came out invalid.
 */
describe("swagger path parameters", () => {
  const route = (method: string, pattern: string): RouteDefinition =>
    ({ method, pattern, handler: async () => {} }) as RouteDefinition;

  it("emits a path parameter for a brace-style dynamic segment", async () => {
    const spec: any = generate([route("GET", "/api/items/{id}")]);

    // The path key was always right - this is the half that was missing.
    expect(spec.paths["/api/items/{id}"], "the path key itself is absent").toBeDefined();

    const params = pathParamsFor(spec, "/api/items/{id}", "get");
    expect(params.map((p) => p.name)).toEqual(["id"]);
    expect(params[0].required).toBe(true);
    expect(params[0].schema?.type).toBe("string");
  });

  it("emits a path parameter for a catch-all segment", async () => {
    const spec: any = generate([route("GET", "/api/files/{...slug}")]);

    const key = Object.keys(spec.paths).find((p) => p.includes("slug"));
    expect(key, "no path key was emitted for the catch-all route").toBeDefined();
    const params = pathParamsFor(spec, key!, "get");
    expect(params.map((p) => p.name)).toEqual(["slug"]);
  });

  it("leaves a static route with no path parameters", async () => {
    // The negative half. A rule that stamped a parameter on every operation
    // would satisfy the two cases above and be just as wrong.
    const spec: any = generate([route("GET", "/api/health")]);

    expect(pathParamsFor(spec, "/api/health", "get")).toEqual([]);
  });

  it("declares a parameter for every template expression in every path", async () => {
    // The invariant as the validator states it, over the whole document rather
    // than one route: this is what actually failed, and it failed on a route
    // the framework registers itself.
    const spec: any = generate([
      route("GET", "/api/items/{id}"),
      route("GET", "/api/orgs/{org}/users/{user}"),
    ]);

    const unresolved: string[] = [];
    for (const [path, ops] of Object.entries<any>(spec.paths ?? {})) {
      const expected = [...path.matchAll(/\{(\.\.\.)?(\w+)\}/g)].map((m) => m[2]);
      for (const [verb, op] of Object.entries<any>(ops ?? {})) {
        if (typeof op !== "object" || op === null) continue;
        const declared = ((op.parameters ?? []) as Param[])
          .filter((p) => p.in === "path")
          .map((p) => p.name);
        for (const want of expected) {
          if (!declared.includes(want)) unresolved.push(`${verb.toUpperCase()} ${path} -> {${want}}`);
        }
      }
    }
    expect(unresolved, `template expressions with no path parameter:\n  ${unresolved.join("\n  ")}`).toEqual([]);
  });
});
