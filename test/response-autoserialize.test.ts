/**
 * response(model) / res.json(model) auto-serialize an ORM model (toDict),
 * a list of models, and a DatabaseResult (records + toArray) without the
 * caller calling .toDict() by hand. Plain objects / strings behave as before.
 * Run with: npx tsx test/response-autoserialize.test.ts
 */
import { createResponse } from "../packages/core/src/index.ts";
import type { ServerResponse } from "node:http";

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

function mockServerResponse() {
  const state: { data: string; statusCode: number; headers: Record<string, string> } = {
    data: "",
    statusCode: 200,
    headers: {},
  };
  const res = {
    headersSent: false,
    get statusCode() { return state.statusCode; },
    set statusCode(c: number) { state.statusCode = c; },
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return state.headers[k.toLowerCase()]; },
    removeHeader(k: string) { delete state.headers[k.toLowerCase()]; },
    write() {},
    end(data?: string) { if (data !== undefined) state.data = data; (res as { headersSent: boolean }).headersSent = true; },
  } as unknown as ServerResponse;
  return { res, state };
}

// Duck-typed fakes (the responder uses duck typing, not @tina4/orm imports).
const model = (data: Record<string, unknown>) => ({ toDict: () => data });
const result = (rows: Record<string, unknown>[]) => ({ records: rows, toArray: () => rows });

{
  const { res, state } = mockServerResponse();
  createResponse(res)(model({ id: 1, name: "alpha", active: true }));
  assert("model -> JSON content type", state.headers["content-type"] === "application/json");
  assert("model -> serialized body", state.data === '{"id":1,"name":"alpha","active":true}', state.data);
}
{
  const { res, state } = mockServerResponse();
  createResponse(res)([model({ id: 1 }), model({ id: 2 })]);
  assert("list[model] -> JSON array", state.data === '[{"id":1},{"id":2}]', state.data);
}
{
  const { res, state } = mockServerResponse();
  createResponse(res)(result([{ id: 1 }, { id: 2 }]));
  assert("DatabaseResult -> records array", state.data === '[{"id":1},{"id":2}]', state.data);
}
{
  const { res, state } = mockServerResponse();
  createResponse(res).json(model({ id: 9 }));
  assert("json(model) -> serialized", state.data === '{"id":9}', state.data);
}
{
  const { res, state } = mockServerResponse();
  createResponse(res)({ ok: true });
  assert("plain object unchanged", state.data === '{"ok":true}', state.data);
}
{
  const { res, state } = mockServerResponse();
  createResponse(res)("<h1>hi</h1>");
  assert("string unchanged (html)", state.data === "<h1>hi</h1>" && state.headers["content-type"] === "text/html; charset=utf-8", state.data);
}

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);
process.exit(fail > 0 ? 1 : 0);
