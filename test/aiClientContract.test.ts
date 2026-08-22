/** ADR-0053 + ADR-0060 app-facing AI client contract over a real HTTP socket. */
import http from "node:http";
import net from "node:net";
import { Ai, AiConfigError, AiHTTPError, AiParseError, AiTimeoutError, type AiEvent } from "@tina4/core";

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
      res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`);
      return res.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    }
    if (path === "/stream-openai-tool") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "get_weather", arguments: "{\"city\":" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"Sydney\",\"unit\":\"c\"}" } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (path === "/stream-anthropic-tool") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_xyz", name: "get_weather" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"city\":" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "\"Sydney\"}" } })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 6 } })}\n\n`);
      return res.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
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
async function collectEvents(stream: AsyncIterable<AiEvent>): Promise<AiEvent[]> { const out: AiEvent[] = []; for await (const event of stream) out.push(event); return out; }
function textFrom(events: AiEvent[]): string[] { return events.filter((event): event is Extract<AiEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text); }

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

  // ── ADR-0060: typed AiEvent stream ────────────────────────────────
  reset(); process.env.TINA4_AI_URL = base + "/stream-openai";
  const eventsOpenai = await collectEvents(Ai.chat([{ role: "user", content: "hello" }], { stream: true }));
  Object.assign(process.env, { TINA4_AI_PROVIDER: "anthropic", TINA4_AI_KEY: "hosted-key", TINA4_AI_URL: base + "/stream-anthropic" });
  const eventsAnthropic = await collectEvents(Ai.chat([{ role: "user", content: "hello" }], { stream: true }));
  const doneEventsOpenai = eventsOpenai.filter((event) => event.type === "done");
  const doneEventsAnthropic = eventsAnthropic.filter((event) => event.type === "done");
  const lastOpenai = eventsOpenai.at(-1);
  const lastAnthropic = eventsAnthropic.at(-1);
  assert("ai_stream_text_deltas_order",
    JSON.stringify(textFrom(eventsOpenai)) === JSON.stringify(["hello ", "world"])
    && JSON.stringify(textFrom(eventsAnthropic)) === JSON.stringify(["hello ", "world"])
    && lastOpenai?.type === "done"
    && lastAnthropic?.type === "done");
  assert("ai_stream_done_fires_once", doneEventsOpenai.length === 1 && doneEventsAnthropic.length === 1 && (doneEventsOpenai[0] as Extract<AiEvent, {type: "done"}>).finishReason === "stop" && (doneEventsAnthropic[0] as Extract<AiEvent, {type: "done"}>).finishReason === "end_turn");

  reset(); process.env.TINA4_AI_URL = base + "/stream-openai-tool";
  const openAiToolEvents = await collectEvents(Ai.chat([{ role: "user", content: "call it" }], { stream: true }));
  const openAiToolCall = openAiToolEvents.find((event) => event.type === "tool_call") as Extract<AiEvent, { type: "tool_call" }> | undefined;
  const openAiDone = openAiToolEvents.find((event) => event.type === "done") as Extract<AiEvent, { type: "done" }> | undefined;
  assert("ai_stream_tool_call_aggregated_openai",
    !!openAiToolCall
    && openAiToolCall.id === "call_abc"
    && openAiToolCall.name === "get_weather"
    && JSON.stringify(openAiToolCall.args) === JSON.stringify({ city: "Sydney", unit: "c" })
    && !!openAiDone
    && openAiDone.finishReason === "tool_calls"
    && openAiDone.usage?.totalTokens === 14
    && openAiToolEvents.indexOf(openAiToolCall) < openAiToolEvents.indexOf(openAiDone));

  reset(); Object.assign(process.env, { TINA4_AI_PROVIDER: "anthropic", TINA4_AI_KEY: "hosted-key", TINA4_AI_URL: base + "/stream-anthropic-tool" });
  const anthropicToolEvents = await collectEvents(Ai.chat([{ role: "user", content: "call it" }], { stream: true }));
  const anthropicToolCall = anthropicToolEvents.find((event) => event.type === "tool_call") as Extract<AiEvent, { type: "tool_call" }> | undefined;
  const anthropicDone = anthropicToolEvents.find((event) => event.type === "done") as Extract<AiEvent, { type: "done" }> | undefined;
  assert("ai_stream_tool_call_aggregated_anthropic",
    !!anthropicToolCall
    && anthropicToolCall.id === "tool_xyz"
    && anthropicToolCall.name === "get_weather"
    && JSON.stringify(anthropicToolCall.args) === JSON.stringify({ city: "Sydney" })
    && !!anthropicDone
    && anthropicDone.finishReason === "tool_use");

  reset(); Object.assign(process.env, { TINA4_AI_PROVIDER: "local", TINA4_AI_MAX_RETRIES: "1", TINA4_AI_URL: base + "/stream-partial" }); delete process.env.TINA4_AI_KEY;
  const partialEvents = await collectEvents(Ai.chat([{ role: "user", content: "hello" }], { stream: true }));
  const partialTexts = textFrom(partialEvents);
  const partialLast = partialEvents.at(-1);
  const partialDoneCount = partialEvents.filter((event) => event.type === "done").length;
  assert("ai_stream_error_instead_of_done_on_midstream_failure",
    partialTexts.length === 1
    && partialTexts[0] === "first"
    && partialLast?.type === "error"
    && partialDoneCount === 0
    && counts["/stream-partial"] === 1);
  assert("ai_stream_no_retry_after_first_event", counts["/stream-partial"] === 1);

  // ── ADR-0060: multimodal content parts ────────────────────────────
  reset(); process.env.TINA4_AI_URL = base + "/openai";
  await Ai.chat([{ role: "user", content: [{ type: "text", text: "describe" }] }]);
  const textPartMessages = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
  assert("ai_multimodal_text_part",
    Array.isArray(textPartMessages)
    && JSON.stringify(textPartMessages[0].content) === JSON.stringify([{ type: "text", text: "describe" }]));

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  await Ai.chat([{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image", source: "data:image/png;base64,AAAA" }] }]);
  const dataUriMessages = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
  const dataUriParts = dataUriMessages[0].content as Array<Record<string, unknown>>;
  assert("ai_multimodal_image_data_uri",
    dataUriParts.length === 2
    && dataUriParts[0].type === "text"
    && dataUriParts[1].type === "image_url"
    && JSON.stringify(dataUriParts[1].image_url) === JSON.stringify({ url: "data:image/png;base64,AAAA" }));

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  await Ai.chat([{ role: "user", content: [{ type: "image", source: "https://example.com/cat.png" }] }]);
  const urlMessages = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
  const urlParts = urlMessages[0].content as Array<Record<string, unknown>>;
  assert("ai_multimodal_image_url",
    urlParts.length === 1
    && urlParts[0].type === "image_url"
    && JSON.stringify(urlParts[0].image_url) === JSON.stringify({ url: "https://example.com/cat.png" }));

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  const badPartUnknown = await throwsType(() => Ai.chat([{ role: "user", content: [{ type: "audio" as "text", text: "no" }] }]), AiConfigError);
  const badPartMissingSource = await throwsType(() => Ai.chat([{ role: "user", content: [{ type: "image" as "image", source: "" }] }]), AiConfigError);
  const badPartWrongScheme = await throwsType(() => Ai.chat([{ role: "user", content: [{ type: "image", source: "ftp://nope" }] }]), AiConfigError);
  const badPartWrongDataUri = await throwsType(() => Ai.chat([{ role: "user", content: [{ type: "image", source: "data:image/png,rawbytes" }] }]), AiConfigError);
  const emptyParts = await throwsType(() => Ai.chat([{ role: "user", content: [] as never }]), AiConfigError);
  assert("ai_multimodal_malformed_part_fails_config",
    !!badPartUnknown && !!badPartMissingSource && !!badPartWrongScheme && !!badPartWrongDataUri && !!emptyParts && requests.length === 0);

  reset(); process.env.TINA4_AI_URL = base + "/openai";
  await Ai.chat([{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: "data:image/jpeg;base64,ZZZZ" }] }]);
  const openaiShape = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
  const openaiParts = openaiShape[0].content as Array<Record<string, unknown>>;
  assert("ai_multimodal_openai_body_shape",
    openaiParts[0].type === "text"
    && (openaiParts[0] as { text: string }).text === "look"
    && openaiParts[1].type === "image_url"
    && JSON.stringify(openaiParts[1].image_url) === JSON.stringify({ url: "data:image/jpeg;base64,ZZZZ" }));

  reset(); Object.assign(process.env, { TINA4_AI_PROVIDER: "anthropic", TINA4_AI_KEY: "hosted-key", TINA4_AI_URL: base + "/anthropic" });
  await Ai.chat([
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: "data:image/png;base64,BBBB" }, { type: "image", source: "https://example.com/photo.jpg" }] },
  ]);
  const anthropicShape = requests.at(-1)?.body.messages as Array<Record<string, unknown>>;
  const anthropicParts = anthropicShape[0].content as Array<Record<string, unknown>>;
  assert("ai_multimodal_anthropic_body_shape",
    anthropicParts.length === 3
    && anthropicParts[0].type === "text"
    && anthropicParts[1].type === "image"
    && JSON.stringify((anthropicParts[1] as { source: unknown }).source) === JSON.stringify({ type: "base64", media_type: "image/png", data: "BBBB" })
    && anthropicParts[2].type === "image"
    && JSON.stringify((anthropicParts[2] as { source: unknown }).source) === JSON.stringify({ type: "url", url: "https://example.com/photo.jpg" }));

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
