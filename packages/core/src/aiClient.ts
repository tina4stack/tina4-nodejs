/** Zero-dependency app-facing AI client (ADR-0053). */
import http, { type IncomingMessage } from "node:http";
import https from "node:https";

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
export interface AiMessage { role: "system" | "user" | "assistant"; content: string }
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
  static chat(messages: AiMessage[], options: AiChatOptions & { stream: true }): AsyncGenerator<string>;
  static chat(messages: AiMessage[], options?: AiChatOptions & { stream?: false }): Promise<ChatResponse>;
  static chat(messages: AiMessage[], options: AiChatOptions = {}): Promise<ChatResponse> | AsyncGenerator<string> {
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

  private static validateMessages(messages: AiMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0 || !messages.every((message) => message && ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string")) {
      throw new AiConfigError("AI messages must contain supported roles and string content");
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

  private static chatBody(config: Config, messages: AiMessage[], options: AiChatOptions): Record<string, unknown> {
    const body: Record<string, unknown> = { model: config.model, messages, stream: options.stream ?? false };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (config.provider === "anthropic") {
      const system = messages.filter((message) => message.role === "system").map((message) => message.content);
      body.messages = messages.filter((message) => message.role !== "system");
      body.max_tokens = options.maxTokens ?? 1024;
      if (system.length) body.system = system.join("\n\n");
    }
    return body;
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

  private static streamDelta(provider: Config["provider"], data: string): { completed: boolean; text?: string } {
    if (data === "[DONE]") return { completed: true };
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { throw new AiParseError("AI provider returned malformed stream data"); }
    const text = provider === "anthropic"
      ? (event.type === "content_block_delta" ? (event.delta as Record<string, unknown>)?.text : undefined)
      : (((event.choices as Array<Record<string, unknown>>)?.[0]?.delta as Record<string, unknown>)?.content);
    if (text !== undefined && text !== null && typeof text !== "string") throw new AiParseError("AI provider returned malformed stream data");
    return { completed: false, text: text as string | undefined };
  }

  private static async *streamData(response: IncomingMessage): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of response) {
      buffer += Buffer.from(chunk).toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
  }

  private static streamError(error: unknown): AiError {
    if (error instanceof AiError) return error;
    if (error instanceof Error && error.name === "AbortError") return new AiTimeoutError("AI total request timeout expired");
    return new AiHTTPError(`AI transport failed (${error instanceof Error ? error.name : "Error"})`);
  }

  private static async *streamRequest(config: Config, headers: Record<string, string>, body: Record<string, unknown>): AsyncGenerator<string> {
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
        let completed = false;
        for await (const data of this.streamData(opened.response)) {
          const delta = this.streamDelta(config.provider, data);
          if (delta.completed) { completed = true; break; }
          if (delta.text === undefined) continue;
          yielded = true; yield delta.text;
        }
        opened.cleanup(); opened = null;
        if (completed) return;
        throw new AiParseError("AI provider stream ended before [DONE]");
      } catch (error) {
        opened?.cleanup();
        const failure = this.streamError(error);
        if (failure instanceof AiParseError || (failure instanceof AiHTTPError && failure.status !== null) || yielded || attempt >= config.maxRetries) throw failure;
      }
    }
  }
}
