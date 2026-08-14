/** ADR-0053 app-facing AI client contract over a real HTTP socket. */
import http from "node:http";
import net from "node:net";
import { Ai, AiConfigError, AiHTTPError, AiParseError, AiTimeoutError } from "@tina4/core";

type Captured = { path: string; body: Record<string, unknown>; authorization?: string; xApiKey?: string };
const requests: Captured[] = [];
const counts: Record<string, number> = {};

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    requests.push({ path, body, authorization: req.headers.authorization, xApiKey: req.headers["x-api-key"] as string | undefined });
    counts[path] = (counts[path] ?? 0) + 1;
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      const encoded = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), ...headers });
      res.end(encoded);
    };
    if (path === "/openai") return json(200, { model: body.model ?? "fixture-model", choices: [{ message: { content: "hello world" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    if (path === "/anthropic") return json(200, { model: body.model ?? "fixture-model", content: [{ type: "text", text: "hello world" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } });
    if (path === "/embeddings") {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return json(200, { data: inputs.map((_item, index) => ({ index, embedding: [Number(index), 0.25, 0.5] })) });
    }
    if (path === "/stream-openai") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (path === "/stream-anthropic") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "hello " } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (path === "/stream-partial") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
    }
    if (path === "/retry" && counts[path] === 1) return json(429, { error: "later" }, { "retry-after": "0" });
    if (path === "/retry") return json(200, { model: "retry-model", choices: [{ message: { content: "recovered" }, finish_reason: "stop" }], usage: {} });
    if (path === "/always500") return json(500, { error: "provider-secret-body" });
    if (path === "/bad400") return json(400, { error: "permanent" });
    if (path === "/slow") return setTimeout(() => json(200, { choices: [{ message: { content: "late" } }] }), 250);
    if (path === "/malformed") return json(200, { choices: [] });
    return json(404, { error: "missing" });
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("real AI contract server did not bind");
const base = `http://127.0.0.1:${address.port}`;

const stalledSockets = new Set<net.Socket>();
const stallServer = net.createServer((socket) => {
  stalledSockets.add(socket);
  socket.once("close", () => stalledSockets.delete(socket));
});
await new Promise<void>((resolve) => stallServer.listen(0, "127.0.0.1", resolve));
const stallAddress = stallServer.address();
if (!stallAddress || typeof stallAddress === "string") throw new Error("real AI stall server did not bind");

let pass = 0;
let fail = 0;
function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) { console.log(`  PASS ${name}`); pass++; }
  else { console.log(`  FAIL ${name} ${detail}`); fail++; }
}
async function throwsType<T extends Error>(fn: () => unknown | Promise<unknown>, type: new (...args: never[]) => T): Promise<T | null> {
  try { await fn(); return null; } catch (error) { return error instanceof type ? error : null; }
}
function reset(): void {
  for (const key of Object.keys(process.env)) if (key.startsWith("TINA4_AI_") || key === "TINA4_EMBED_URL") delete process.env[key];
  Object.assign(process.env, { TINA4_AI_MODEL: "env-model", TINA4_AI_TIMEOUT: "2", TINA4_AI_CONNECT_TIMEOUT: "1", TINA4_AI_MAX_RETRIES: "0" });
  requests.length = 0;
  for (const key of Object.keys(counts)) delete counts[key];
}
async function collect(stream: AsyncIterable<string>): Promise<string[]> { const out: string[] = []; for await (const part of stream) out.push(part); return out; }

try {
  reset(); process.env.TINA4_AI_URL = base + "/openai";
  const publicChat = await Ai.chat([{ role: "user", content: "hello" }]);
  const publicComplete = await Ai.complete("hello");
  process.env.TINA4_EMBED_URL = base + "/embeddings";
  const publicEmbed = await Ai.embed("hello");
  assert("ai_public_surface", publicChat.text === "hello world" && publicComplete === "hello world" && JSON.stringify(publicEmbed) === JSON.stringify([0, 0.25, 0.5]) && !("ask" in Ai) && !("vision" in Ai));

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  const openai = await Ai.chat([{ role: "user", content: "hello" }], { model: "call-model" });
  Object.assign(process.env, { TINA4_AI_PROVIDER: "anthropic", TINA4_AI_KEY: "hosted-key", TINA4_AI_URL: base + "/anthropic" });
  const anthropic = await Ai.chat([{ role: "user", content: "hello" }]);
  assert("ai_chat_response_normalized", openai.model === "call-model" && openai.usage.totalTokens === 5 && openai.finishReason === "stop" && anthropic.text === "hello world" && anthropic.usage.totalTokens === 5 && anthropic.finishReason === "end_turn");

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  assert("ai_complete_is_single_turn_text", await Ai.complete("only this") === "hello world" && JSON.stringify(requests.at(-1)?.body.messages) === JSON.stringify([{ role: "user", content: "only this" }]));

  reset(); process.env.TINA4_EMBED_URL = base + "/embeddings";
  assert("ai_embedding_cardinality", JSON.stringify(await Ai.embed("one")) === JSON.stringify([0, 0.25, 0.5]) && JSON.stringify(await Ai.embed(["one", "two"])) === JSON.stringify([[0, 0.25, 0.5], [1, 0.25, 0.5]]));

  reset(); process.env.TINA4_AI_URL = base + "/stream-openai";
  const streamOpenai = await collect(Ai.chat([{ role: "user", content: "hello" }], { stream: true }));
  Object.assign(process.env, { TINA4_AI_PROVIDER: "anthropic", TINA4_AI_KEY: "hosted-key", TINA4_AI_URL: base + "/stream-anthropic" });
  const streamAnthropic = await collect(Ai.chat([{ role: "user", content: "hello" }], { stream: true }));
  Object.assign(process.env, { TINA4_AI_PROVIDER: "local", TINA4_AI_MAX_RETRIES: "1", TINA4_AI_URL: base + "/stream-partial" }); delete process.env.TINA4_AI_KEY;
  const partialError = await throwsType(() => collect(Ai.chat([{ role: "user", content: "hello" }], { stream: true })), AiParseError);
  assert("ai_stream_is_ordered_deltas", JSON.stringify(streamOpenai) === JSON.stringify(["hello ", "world"]) && JSON.stringify(streamAnthropic) === JSON.stringify(["hello ", "world"]) && !!partialError && counts["/stream-partial"] === 1);

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  await Ai.chat([{ role: "user", content: "hello" }], { model: "call-model", temperature: 0.2, maxTokens: 9 });
  assert("ai_configuration_precedence", requests[0]?.body.model === "call-model" && requests[0]?.body.temperature === 0.2 && requests[0]?.body.max_tokens === 9);

  reset(); Object.assign(process.env, { TINA4_AI_PROVIDER: "openai", TINA4_AI_URL: base + "/openai" });
  const missingKey = await throwsType(() => Ai.chat([{ role: "user", content: "private prompt" }]), AiConfigError);
  Object.assign(process.env, { TINA4_AI_KEY: "super-secret-key", TINA4_AI_URL: base + "/always500" });
  const httpError = await throwsType(() => Ai.chat([{ role: "user", content: "private prompt" }]), AiHTTPError);
  assert("ai_hosted_key_fails_closed_and_redacted", !!missingKey && requests.length === 1 && !!httpError && !httpError.message.includes("super-secret-key") && !httpError.message.includes("private prompt") && !httpError.message.includes("provider-secret-body"));

  reset(); Object.assign(process.env, { TINA4_AI_MAX_RETRIES: "1", TINA4_AI_URL: base + "/retry" });
  const recovered = await Ai.complete("hello"); process.env.TINA4_AI_URL = base + "/bad400";
  const bad400 = await throwsType(() => Ai.complete("hello"), AiHTTPError);
  assert("ai_retries_only_safe_transients", recovered === "recovered" && !!bad400 && counts["/retry"] === 2 && counts["/bad400"] === 1);

  reset(); process.env.TINA4_AI_URL = base + "/slow"; const started = performance.now();
  const timedOut = await throwsType(() => Ai.chat([{ role: "user", content: "hello" }], { timeout: 0.05 }), AiTimeoutError);
  const invalidTimeout = await throwsType(() => Ai.chat([{ role: "user", content: "hello" }], { timeout: 0 }), AiConfigError);
  Object.assign(process.env, { TINA4_AI_URL: `https://127.0.0.1:${stallAddress.port}/stall`, TINA4_AI_CONNECT_TIMEOUT: "0.05" });
  const connectStarted = performance.now();
  const connectTimedOut = await throwsType(() => Ai.chat([{ role: "user", content: "hello" }], { timeout: 1 }), AiTimeoutError);
  assert("ai_timeouts_are_distinct_and_bounded", !!timedOut && timedOut.message.includes("total") && performance.now() - started < 500 && !!connectTimedOut && connectTimedOut.message.includes("connection") && performance.now() - connectStarted < 500 && !!invalidTimeout);

  reset(); process.env.TINA4_AI_URL = base + "/malformed";
  assert("ai_zero_runtime_dependencies_real_socket", !!await throwsType(() => Ai.chat([{ role: "user", content: "hello" }]), AiParseError));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const socket of stalledSockets) socket.destroy();
  await new Promise<void>((resolve) => stallServer.close(() => resolve()));
}

console.log(`Results: ${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
