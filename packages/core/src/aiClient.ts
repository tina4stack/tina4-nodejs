/** Zero-dependency app-facing AI client (ADR-0053 + ADR-0060). */
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { parseLineStream, parseSseStream, type SseEvent } from "./api.js";

export class AiError extends Error {}
export class AiConfigError extends AiError {}
export class AiTimeoutError extends AiError {}
export class AiParseError extends AiError {}
export class AiHTTPError extends AiError {
  constructor(message: string, public readonly status: number | null = null) { super(message); }
}

export interface ChatResponse {
  text: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: string | null;
  raw: Record<string, unknown>;
}

/**
 * A multimodal content part. `text` carries plain UTF-8 prose; `image`
 * carries a `data:<media_type>;base64,<payload>` URI or an https:// URL
 * (the client translates to each provider's shape). ADR-0060.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: string };

/** The value a caller may pass for `message.content`. ADR-0060. */
export type AiMessageContent = string | ContentPart[];

export interface AiMessage { role: "system" | "user" | "assistant"; content: AiMessageContent }

/**
 * One event yielded by `Ai.chat(stream: true)`. The four variants
 * discriminated by `type`. Text deltas arrive per chunk (typewriter UX);
 * `tool_call` fires once per call, aggregated from provider fragments;
 * `done` fires exactly once after all deltas; `error` replaces `done` on
 * mid-stream failure. ADR-0060.
 */
export type AiEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | {
      type: "done";
      finishReason: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }
  | { type: "error"; message: string; code?: string };

export interface AiChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  timeout?: number;
  provider?: "local" | "openai" | "anthropic";
}
export interface AiEmbedOptions { model?: string; timeout?: number; provider?: "local" | "openai" | "anthropic" }

interface Config {
  provider: "local" | "openai" | "anthropic";
  url: string;
  model: string;
  key: string | null;
  totalTimeout: number;
  connectTimeout: number;
  maxRetries: number;
}
interface OpenResponse { response: IncomingMessage; cleanup: () => void }

export class Ai {
  static chat(messages: AiMessage[], options: AiChatOptions & { stream: true }): AsyncGenerator<AiEvent>;
  static chat(messages: AiMessage[], options?: AiChatOptions & { stream?: false }): Promise<ChatResponse>;
  static chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<ChatResponse> | AsyncGenerator<AiEvent> {
    this.validateMessages(messages);
    const config = this.config("chat", options);
    const body = this.chatBody(config, messages, options);
    const headers = this.headers(config);
    return options.stream ? this.streamRequest(config, headers, body) : this.chatResponse(config, headers, body);
  }

  static async complete(prompt: string, options: Omit<AiChatOptions, "stream"> = {}): Promise<string> {
    if (typeof prompt !== "string") throw new AiConfigError("AI prompt must be a string");
    return (await this.chat([{ role: "user", content: prompt }], { ...options, stream: false })).text;
  }

  static async embed(textOrTexts: string | string[], options: AiEmbedOptions = {}): Promise<number[] | number[][]> {
    const single = typeof textOrTexts === "string";
    if (!single && (!Array.isArray(textOrTexts) || textOrTexts.length === 0 || !textOrTexts.every((item) => typeof item === "string"))) {
      throw new AiConfigError("AI embedding input must be a string or a non-empty list of strings");
    }
    const config = this.config("embed", options);
    if (config.provider === "anthropic") throw new AiConfigError("Anthropic does not provide the embedding endpoint in this contract");
    const raw = await this.requestJson(config, this.headers(config), { model: config.model, input: textOrTexts });
    try {
      const data = (raw.data as Array<{ index?: number; embedding?: unknown }>).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = data.map((item) => item.embedding);
      const expected = single ? 1 : textOrTexts.length;
      if (vectors.length !== expected || !vectors.every((vector) => Array.isArray(vector) && vector.length > 0 && vector.every((value) => typeof value === "number" && Number.isFinite(value)))) throw new Error();
      return single ? vectors[0] as number[] : vectors as number[][];
    } catch {
      throw new AiParseError("AI provider returned a malformed embedding response");
    }
  }

  /**
   * Validate role + content shape. Content may be a string OR a non-empty
   * list of {type:'text'|'image', ...} parts (ADR-0060). Malformed parts
   * fail fast with AiConfigError, never reaching the wire.
   */
  private static validateMessages(messages: AiMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AiConfigError("AI messages must contain supported roles and string content");
    }
    for (const message of messages) {
      if (!message || !["system", "user", "assistant"].includes(message.role)) {
        throw new AiConfigError("AI messages must contain supported roles and string content");
      }
      this.validateContent(message.content);
    }
  }

  private static validateContent(content: unknown): void {
    if (typeof content === "string") return;
    if (!Array.isArray(content) || content.length === 0) {
      throw new AiConfigError("AI message content must be a string or a non-empty list of parts");
    }
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw new AiConfigError("AI content part must be an object with type and text/source");
      }
      const record = part as Record<string, unknown>;
      const partType = record.type;
      if (partType === "text") {
        if (typeof record.text !== "string") {
          throw new AiConfigError("AI text content part requires a string 'text' field");
        }
      } else if (partType === "image") {
        if (typeof record.source !== "string" || record.source.length === 0) {
          throw new AiConfigError("AI image content part requires a non-empty string 'source' field");
        }
        if (!record.source.startsWith("data:") && !record.source.startsWith("https://")) {
          throw new AiConfigError("AI image source must be a data: URI or an https:// URL");
        }
        if (record.source.startsWith("data:") && !/^data:[^;,\s]+;base64,[A-Za-z0-9+/=]+$/.test(record.source)) {
          throw new AiConfigError("AI image data URI must be data:<media_type>;base64,<payload>");
        }
      } else {
        throw new AiConfigError(`AI content part has unknown type '${String(partType)}'`);
      }
    }
  }

  private static number(name: string, fallback: number, minimum: number): number {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isFinite(value) || value < minimum) throw new AiConfigError(`${name} must be numeric and at least ${minimum}`);
    return value;
  }

  private static config(capability: "chat" | "embed", options: AiChatOptions | AiEmbedOptions): Config {
    const provider = (options.provider ?? process.env.TINA4_AI_PROVIDER ?? "local").trim().toLowerCase();
    if (provider !== "local" && provider !== "openai" && provider !== "anthropic") throw new AiConfigError("TINA4_AI_PROVIDER must be local, openai, or anthropic");
    const key = process.env.TINA4_AI_KEY || null;
    if ((provider === "openai" || provider === "anthropic") && !key) throw new AiConfigError(`TINA4_AI_KEY is required for the ${provider} provider`);
    const defaults: Record<Config["provider"], [string, string]> = {
      local: ["http://localhost:11437", "llama3.2"],
      openai: ["https://api.openai.com/v1", "gpt-4o-mini"],
      anthropic: ["https://api.anthropic.com/v1", "claude-3-5-haiku-latest"],
    };
    const rawUrl = capability === "embed" && process.env.TINA4_EMBED_URL ? process.env.TINA4_EMBED_URL : (process.env.TINA4_AI_URL ?? defaults[provider][0]);
    const model = (options.model ?? process.env.TINA4_AI_MODEL ?? defaults[provider][1]).trim();
    if (!model) throw new AiConfigError("AI model must be a non-empty string");
    const totalTimeout = options.timeout === undefined ? this.number("TINA4_AI_TIMEOUT", 60, 0.001) : Number(options.timeout);
    if (!Number.isFinite(totalTimeout) || totalTimeout <= 0) throw new AiConfigError("AI timeout must be greater than zero");
    return { provider, url: this.endpoint(rawUrl, capability, provider), model, key, totalTimeout, connectTimeout: this.number("TINA4_AI_CONNECT_TIMEOUT", 10, 0.001), maxRetries: Math.trunc(this.number("TINA4_AI_MAX_RETRIES", 2, 0)) };
  }

  private static endpoint(value: string, capability: "chat" | "embed", provider: Config["provider"]): string {
    let url: URL;
    try { url = new URL(value); } catch { throw new AiConfigError("AI URL must be an http or https URL"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new AiConfigError("AI URL must be an http or https URL");
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "" || path === "/v1" || path === "/api") {
      const suffix = provider === "anthropic" ? "/messages" : capability === "embed" ? "/embeddings" : "/chat/completions";
      url.pathname = (path || "/v1") + suffix;
    }
    return url.toString();
  }

  private static headers(config: Config): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (config.provider === "openai") headers.authorization = `Bearer ${config.key}`;
    if (config.provider === "anthropic") { headers["x-api-key"] = config.key!; headers["anthropic-version"] = "2023-06-01"; }
    return headers;
  }

  /**
   * Build the provider-specific request body from a Tina4-shaped message
   * list. Multimodal parts are translated per provider (ADR-0060):
   *   - OpenAI/local: {type:'image_url', image_url:{url}}
   *   - Anthropic:    {type:'image', source:{type:'base64'|'url', ...}}
   * String content is preserved verbatim in the OpenAI/local shape and
   * likewise for Anthropic (both accept a bare string).
   */
  private static chatBody(config: Config, messages: AiMessage[], options: AiChatOptions): Record<string, unknown> {
    const translate = (list: AiMessage[]): Array<Record<string, unknown>> =>
      list.map((message) => ({ role: message.role, content: this.translateContent(message.content, config.provider) }));
    const body: Record<string, unknown> = { model: config.model, messages: translate(messages), stream: options.stream ?? false };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (config.provider === "anthropic") {
      const systemParts = messages
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : this.contentToPlainText(message.content)));
      body.messages = translate(messages.filter((message) => message.role !== "system"));
      body.max_tokens = options.maxTokens ?? 1024;
      if (systemParts.length) body.system = systemParts.join("\n\n");
    }
    return body;
  }

  /**
   * Translate one message content value into the provider's on-wire shape.
   * A plain string is passed through (both providers accept a string
   * content). A parts array becomes provider-native content blocks.
   */
  private static translateContent(content: AiMessageContent, provider: Config["provider"]): unknown {
    if (typeof content === "string") return content;
    if (provider === "anthropic") {
      return content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.source.startsWith("data:")) {
          const parsed = this.parseDataUri(part.source);
          return { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } };
        }
        return { type: "image", source: { type: "url", url: part.source } };
      });
    }
    return content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      return { type: "image_url", image_url: { url: part.source } };
    });
  }

  private static parseDataUri(source: string): { mediaType: string; data: string } {
    const match = /^data:([^;,\s]+);base64,([A-Za-z0-9+/=]+)$/.exec(source);
    if (!match) throw new AiConfigError("AI image data URI must be data:<media_type>;base64,<payload>");
    return { mediaType: match[1], data: match[2] };
  }

  private static contentToPlainText(parts: ContentPart[]): string {
    return parts.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("\n\n");
  }

  private static open(config: Config, deadline: number, headers: Record<string, string>, body: Record<string, unknown>): Promise<OpenResponse> {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return Promise.reject(new AiTimeoutError("AI total request timeout expired"));
    const url = new URL(config.url);
    const payload = JSON.stringify(body);
    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(new AiTimeoutError("AI total request timeout expired")), remainingMs);
    return new Promise((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const request = client.request(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(payload) }, signal: controller.signal }, (response) => {
        clearTimeout(connectTimer);
        resolve({ response, cleanup: () => { clearTimeout(totalTimer); clearTimeout(connectTimer); } });
      });
      const connectTimer = setTimeout(() => request.destroy(new AiTimeoutError("AI connection timeout expired")), Math.min(config.connectTimeout * 1000, remainingMs));
      request.on("socket", (socket) => {
        if (!socket.connecting) clearTimeout(connectTimer);
        socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
      });
      request.once("error", (error) => {
        clearTimeout(totalTimer); clearTimeout(connectTimer);
        if (error instanceof AiError) reject(error);
        else if (controller.signal.aborted) reject(new AiTimeoutError("AI total request timeout expired"));
        else reject(new AiHTTPError(`AI transport failed (${error.name})`));
      });
      request.end(payload);
    });
  }

  private static async readBody(response: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  private static retryDelay(headers: http.IncomingHttpHeaders, deadline: number): Promise<void> {
    const value = Array.isArray(headers["retry-after"]) ? headers["retry-after"][0] : headers["retry-after"];
    const requested = value !== undefined && Number.isFinite(Number(value)) ? Math.max(0, Number(value) * 1000) : 100;
    const delay = Math.min(requested, Math.max(0, deadline - performance.now()));
    return new Promise((resolve) => setTimeout(resolve, delay));
  }

  private static async requestJson(config: Config, headers: Record<string, string>, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const deadline = performance.now() + config.totalTimeout * 1000;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      let opened: OpenResponse | null = null;
      try {
        opened = await this.open(config, deadline, headers, body);
        const status = opened.response.statusCode ?? 0;
        const responseHeaders = opened.response.headers;
        const raw = await this.readBody(opened.response);
        opened.cleanup(); opened = null;
        if (status < 200 || status >= 300) {
          if ((status === 429 || status >= 500) && attempt < config.maxRetries) { await this.retryDelay(responseHeaders, deadline); continue; }
          throw new AiHTTPError(`AI provider returned HTTP ${status}`, status);
        }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new AiParseError("AI provider returned malformed JSON"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AiParseError("AI provider returned a non-object JSON response");
        return parsed as Record<string, unknown>;
      } catch (error) {
        opened?.cleanup();
        if (error instanceof AiParseError || (error instanceof AiHTTPError && error.status !== null)) throw error;
        if (attempt >= config.maxRetries) throw error;
      }
    }
    throw new AiHTTPError("AI request failed");
  }

  private static normalizeChat(provider: Config["provider"], raw: Record<string, unknown>): ChatResponse {
    try {
      if (provider === "anthropic") {
        const content = raw.content as Array<{ type?: string; text?: unknown }>;
        const parts = content.filter((item) => (item.type ?? "text") === "text").map((item) => item.text);
        if (!parts.length || !parts.every((part) => typeof part === "string")) throw new Error();
        const usage = (raw.usage ?? {}) as Record<string, unknown>;
        const promptTokens = Number(usage.input_tokens ?? 0); const completionTokens = Number(usage.output_tokens ?? 0);
        return { text: parts.join(""), model: String(raw.model ?? ""), usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, finishReason: raw.stop_reason == null ? null : String(raw.stop_reason), raw };
      }
      const choice = (raw.choices as Array<Record<string, unknown>>)[0];
      const text = (choice.message as Record<string, unknown>).content;
      if (typeof text !== "string") throw new Error();
      const usage = (raw.usage ?? {}) as Record<string, unknown>;
      return { text, model: String(raw.model ?? ""), usage: { promptTokens: Number(usage.prompt_tokens ?? 0), completionTokens: Number(usage.completion_tokens ?? 0), totalTokens: Number(usage.total_tokens ?? 0) }, finishReason: choice.finish_reason == null ? null : String(choice.finish_reason), raw };
    } catch { throw new AiParseError("AI provider returned a malformed chat response"); }
  }

  private static async chatResponse(config: Config, headers: Record<string, string>, body: Record<string, unknown>): Promise<ChatResponse> {
    return this.normalizeChat(config.provider, await this.requestJson(config, headers, body));
  }

  /**
   * Stream the response through the shared {@link parseSseStream} framer
   * (ADR-0060 rule 5). Translates each SSE data payload into 0..N
   * {@link AiEvent}s: text_delta per chunk, tool_call aggregated per
   * index / block, exactly one done (or error) at the end.
   */
  private static async *streamRequest(config: Config, headers: Record<string, string>, body: Record<string, unknown>): AsyncGenerator<AiEvent> {
    const deadline = performance.now() + config.totalTimeout * 1000;
    let yielded = false;
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      let opened: OpenResponse | null = null;
      try {
        opened = await this.open(config, deadline, { ...headers, accept: "text/event-stream" }, body);
        const status = opened.response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          await this.readBody(opened.response);
          if ((status === 429 || status >= 500) && attempt < config.maxRetries) { await this.retryDelay(opened.response.headers, deadline); opened.cleanup(); opened = null; continue; }
          throw new AiHTTPError(`AI provider returned HTTP ${status}`, status);
        }
        const response = opened.response;
        const chunks = this.responseChunks(response);
        const events = parseSseStream(parseLineStream(chunks));
        const aggregator = new AggregateState(config.provider);
        let done = false;
        try {
          for await (const sseEvent of events) {
            for (const emitted of aggregator.consume(sseEvent)) {
              yielded = true;
              yield emitted;
              if (emitted.type === "done" || emitted.type === "error") { done = true; break; }
            }
            if (done) break;
          }
        } catch (error) {
          if (yielded) {
            yielded = true;
            yield { type: "error", message: error instanceof AiParseError ? "AI provider returned malformed stream data" : `AI transport failed (${error instanceof Error ? error.name : "Error"})` };
            opened.cleanup(); opened = null;
            return;
          }
          throw error;
        }
        opened.cleanup(); opened = null;
        if (done) return;
        // Stream ended without a terminator — treat as mid-stream failure.
        if (yielded) { yield { type: "error", message: "AI provider stream ended before completion" }; return; }
        throw new AiParseError("AI provider stream ended before completion");
      } catch (error) {
        opened?.cleanup();
        const failure = this.streamError(error);
        if (yielded) {
          yield { type: "error", message: failure.message };
          return;
        }
        if (failure instanceof AiParseError || (failure instanceof AiHTTPError && failure.status !== null) || attempt >= config.maxRetries) throw failure;
      }
    }
  }

  private static async *responseChunks(response: IncomingMessage): AsyncGenerator<Uint8Array> {
    for await (const chunk of response) {
      yield chunk as Uint8Array;
    }
  }

  private static streamError(error: unknown): AiError {
    if (error instanceof AiError) return error;
    if (error instanceof Error && error.name === "AbortError") return new AiTimeoutError("AI total request timeout expired");
    return new AiHTTPError(`AI transport failed (${error instanceof Error ? error.name : "Error"})`);
  }
}

/**
 * Per-stream aggregation state. Encapsulates the buffering rules for
 * OpenAI-style `tool_calls[i].function.arguments` fragments and
 * Anthropic-style `content_block_delta` + `input_json_delta` fragments.
 * ADR-0060 "tool_call aggregated" invariant.
 */
class AggregateState {
  private toolBuffers = new Map<string, { id: string; name: string; args: string }>();
  private lastFinishReason: string | null = null;
  private lastUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
  private doneEmitted = false;

  constructor(private readonly provider: Config["provider"]) {}

  *consume(event: SseEvent): Iterable<AiEvent> {
    const data = event.data;
    if (data === "[DONE]") {
      if (this.doneEmitted) return;
      yield* this.flushRemainingToolCalls();
      this.doneEmitted = true;
      yield {
        type: "done",
        finishReason: this.lastFinishReason ?? "stop",
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      };
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      throw new AiParseError("AI provider returned malformed stream data");
    }
    if (this.provider === "anthropic") {
      yield* this.consumeAnthropic(payload);
    } else {
      yield* this.consumeOpenAi(payload);
    }
  }

  private *consumeOpenAi(payload: Record<string, unknown>): Iterable<AiEvent> {
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const choice = choices[0];
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      yield { type: "text_delta", text: content };
    }
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const call of toolCalls) {
        const index = typeof call.index === "number" ? String(call.index) : String(this.toolBuffers.size);
        const idFromCall = typeof call.id === "string" ? call.id : "";
        const fn = (call.function ?? {}) as Record<string, unknown>;
        const nameFromCall = typeof fn.name === "string" ? fn.name : "";
        const argsFragment = typeof fn.arguments === "string" ? fn.arguments : "";
        const existing = this.toolBuffers.get(index) ?? { id: "", name: "", args: "" };
        if (idFromCall) existing.id = idFromCall;
        if (nameFromCall) existing.name = nameFromCall;
        existing.args += argsFragment;
        this.toolBuffers.set(index, existing);
        if (existing.name && existing.args) {
          try {
            const parsed = JSON.parse(existing.args) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              this.toolBuffers.delete(index);
              yield { type: "tool_call", id: existing.id || `call_${index}`, name: existing.name, args: parsed as Record<string, unknown> };
            }
          } catch {
            /* args not complete yet — keep buffering */
          }
        }
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
      this.lastFinishReason = choice.finish_reason;
    }
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (usage && typeof usage === "object") {
      const promptTokens = Number(usage.prompt_tokens ?? 0);
      const completionTokens = Number(usage.completion_tokens ?? 0);
      const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
      if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) {
        this.lastUsage = { promptTokens, completionTokens, totalTokens };
      }
    }
  }

  private *consumeAnthropic(payload: Record<string, unknown>): Iterable<AiEvent> {
    const type = payload.type;
    if (type === "content_block_start") {
      const block = (payload.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "tool_use") {
        const index = String(payload.index ?? this.toolBuffers.size);
        const id = typeof block.id === "string" ? block.id : `call_${index}`;
        const name = typeof block.name === "string" ? block.name : "";
        this.toolBuffers.set(index, { id, name, args: "" });
      }
      return;
    }
    if (type === "content_block_delta") {
      const index = String(payload.index ?? 0);
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        yield { type: "text_delta", text: delta.text };
        return;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const existing = this.toolBuffers.get(index);
        if (existing) existing.args += delta.partial_json;
      }
      return;
    }
    if (type === "content_block_stop") {
      const index = String(payload.index ?? 0);
      const existing = this.toolBuffers.get(index);
      if (existing && existing.name) {
        this.toolBuffers.delete(index);
        try {
          const parsed = existing.args ? JSON.parse(existing.args) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            yield { type: "tool_call", id: existing.id, name: existing.name, args: parsed as Record<string, unknown> };
            return;
          }
          throw new Error();
        } catch {
          throw new AiParseError("AI provider returned malformed tool-call JSON");
        }
      }
      return;
    }
    if (type === "message_delta") {
      const delta = (payload.delta ?? {}) as Record<string, unknown>;
      if (typeof delta.stop_reason === "string" && delta.stop_reason.length > 0) {
        this.lastFinishReason = delta.stop_reason;
      }
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      if (usage.output_tokens !== undefined || usage.input_tokens !== undefined) {
        const promptTokens = Number(usage.input_tokens ?? this.lastUsage?.promptTokens ?? 0);
        const completionTokens = Number(usage.output_tokens ?? this.lastUsage?.completionTokens ?? 0);
        this.lastUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
      }
      return;
    }
    if (type === "message_stop") {
      if (this.doneEmitted) return;
      this.doneEmitted = true;
      yield {
        type: "done",
        finishReason: this.lastFinishReason ?? "end_turn",
        ...(this.lastUsage ? { usage: this.lastUsage } : {}),
      };
      return;
    }
    if (type === "message_start") {
      const message = (payload.message ?? {}) as Record<string, unknown>;
      const usage = (message.usage ?? {}) as Record<string, unknown>;
      if (usage.input_tokens !== undefined || usage.output_tokens !== undefined) {
        const promptTokens = Number(usage.input_tokens ?? 0);
        const completionTokens = Number(usage.output_tokens ?? 0);
        this.lastUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
      }
      return;
    }
    if (type === "error") {
      const err = (payload.error ?? {}) as Record<string, unknown>;
      throw new AiParseError(typeof err.message === "string" ? err.message : "AI provider signalled a stream error");
    }
  }

  private *flushRemainingToolCalls(): Iterable<AiEvent> {
    for (const [index, buffered] of this.toolBuffers) {
      if (buffered.name && buffered.args) {
        try {
          const parsed = JSON.parse(buffered.args) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            yield { type: "tool_call", id: buffered.id || `call_${index}`, name: buffered.name, args: parsed as Record<string, unknown> };
            continue;
          }
        } catch {
          /* fall through to error */
        }
        throw new AiParseError("AI provider returned malformed tool-call JSON");
      }
    }
    this.toolBuffers.clear();
  }
}
