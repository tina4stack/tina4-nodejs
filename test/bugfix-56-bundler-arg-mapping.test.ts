/**
 * Regression test for #56 — Function.toString() arg mapping breaks under bundlers.
 *
 * A handler declared with a bundler-renamed first parameter (`req2`, `_a`, `$0`)
 * used to receive the Response object as its first arg because the arg mapper
 * only matched the literal names `req` / `request`; anything else fell through
 * to the `else` branch and got `res`. Every POST body then read as empty.
 *
 * The fix: for any parameter name that is NOT already resolved as a route
 * param, `req`/`request`, or `res`/`response`, fall back to POSITIONAL binding
 * (first unmatched -> request, rest -> response). Bundler-safe by construction.
 *
 * Tested directly against the exported `resolveHandlerArgs` helper so the
 * regression pins the pure arg-mapping behaviour without needing a live server.
 * No mocks: the helper receives real `Tina4Request` / `Tina4Response` shapes
 * built here.
 */
import { resolveHandlerArgs } from "../packages/core/src/server.ts";

let pass = 0;
let fail = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) { console.log(`  \x1b[32mPASS\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`); fail++; }
}

// Real Tina4Request / Tina4Response are structural — build minimal shapes with
// distinct identities so equality checks tell us WHICH object was bound where.
const req: any = { body: { ping: "pong" }, params: {}, __marker: "REQ" };
const res: any = { __marker: "RES" };
const routeParams: Record<string, unknown> = {};

// --- by-name path (existing behaviour preserved) ---
const named = async (req: any, res: any) => [req, res];
const namedArgs = resolveHandlerArgs(named, req, res, routeParams);
assert("named_req_res_by_name", namedArgs[0] === req && namedArgs[1] === res,
  `got [${(namedArgs[0] as any)?.__marker}, ${(namedArgs[1] as any)?.__marker}]`);

const namedLong = async (request: any, response: any) => [request, response];
const namedLongArgs = resolveHandlerArgs(namedLong, req, res, routeParams);
assert("named_request_response_by_name", namedLongArgs[0] === req && namedLongArgs[1] === res,
  `got [${(namedLongArgs[0] as any)?.__marker}, ${(namedLongArgs[1] as any)?.__marker}]`);

// --- the bundler-renamed cases (previously broke) ---
const bundlerRenamed = async (req2: any, res: any) => [req2, res];
const bundlerArgs = resolveHandlerArgs(bundlerRenamed, req, res, routeParams);
assert("bundler_renamed_first_arg_receives_request",
  bundlerArgs[0] === req && bundlerArgs[1] === res,
  `got [${(bundlerArgs[0] as any)?.__marker}, ${(bundlerArgs[1] as any)?.__marker}]`);

const minified = async (a: any, b: any) => [a, b];
const minifiedArgs = resolveHandlerArgs(minified, req, res, routeParams);
assert("minified_single_letter_names_still_map_positionally",
  minifiedArgs[0] === req && minifiedArgs[1] === res,
  `got [${(minifiedArgs[0] as any)?.__marker}, ${(minifiedArgs[1] as any)?.__marker}]`);

// --- route params still win over positional (order matters) ---
const withRouteParam = async (id: string, req2: any, res: any) => [id, req2, res];
const routeArgs = resolveHandlerArgs(withRouteParam, req, res, { id: "42" });
assert("route_param_by_name_still_wins",
  routeArgs[0] === "42" && routeArgs[1] === req && routeArgs[2] === res,
  `got [${routeArgs[0]}, ${(routeArgs[1] as any)?.__marker}, ${(routeArgs[2] as any)?.__marker}]`);

// --- zero-arity handler ---
const zeroArity = async () => "ok";
const zeroArgs = resolveHandlerArgs(zeroArity, req, res, routeParams);
assert("zero_arity_returns_empty_list", zeroArgs.length === 0, `got length=${zeroArgs.length}`);

// --- 3+ unmatched args: first -> req, rest -> res ---
const threeUnmatched = async (x: any, y: any, z: any) => [x, y, z];
const threeArgs = resolveHandlerArgs(threeUnmatched, req, res, routeParams);
assert("three_unmatched_first_is_req_rest_is_res",
  threeArgs[0] === req && threeArgs[1] === res && threeArgs[2] === res,
  `got [${(threeArgs[0] as any)?.__marker}, ${(threeArgs[1] as any)?.__marker}, ${(threeArgs[2] as any)?.__marker}]`);

// --- res-named-only still resolves via the alias path ---
const resNamedOnly = async (x: any, response: any) => [x, response];
const resNamedArgs = resolveHandlerArgs(resNamedOnly, req, res, routeParams);
assert("res_alias_resolves_response_and_first_falls_back_to_req",
  resNamedArgs[0] === req && resNamedArgs[1] === res,
  `got [${(resNamedArgs[0] as any)?.__marker}, ${(resNamedArgs[1] as any)?.__marker}]`);

console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
