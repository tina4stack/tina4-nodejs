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
 * (the client translates to each provider's shape, ADR-0060). `tool_result`
 * carries the Anthropic-style return of a locally-executed tool call
 * (ADR-0061); the client translates it to OpenAI's `{role: "tool", ...}`
 * turn on non-Anthropic providers.
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: string }
  | { type: "tool_result"; tool_use_id: string; content: string };

/** The value a caller may pass for `message.content`. ADR-0060. */
export type AiMessageContent = string | ContentPart[];

/**
 * One conversation turn. The three "chat" roles carry a string OR a
 * content-parts array (ADR-0060). The `tool` role is the OpenAI-style
 * return of a tool call (ADR-0061); the client translates it to the
 * Anthropic user-turn form when the current provider is Anthropic.
 */
export type AiMessage =
  | { role: "system" | "user" | "assistant"; content: AiMessageContent }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * A tool declaration the model may call (named `AiToolDeclaration` to
 * stay out of the way of {@link ./ai.ts}'s existing `AiTool` interface
 * for AI-coding-tool context installation). `parameters` is a JSON
 * Schema object; it is passed to the provider unchanged (ADR-0061
 * `parameters-passthrough`).
 */
export interface AiToolDeclaration { name: string; description: string; parameters: Record<string, unknown> }

/**
 * How the model picks a tool. Four Tina4 values that span the useful cases
 * across providers (ADR-0061 wire-translation table):
 *   'auto'       — model may call any tool or answer with text
 *   'none'       — model must not call a tool (Anthropic omits `tools`)
 *   'required'   — model must call some tool
 *   {name: 'x'}  — model must call tool 'x'
 */
export type AiToolChoice = "auto" | "none" | "required" | { name: string };

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
  /** Tools the model may call. ADR-0061 — translated per provider. */
  tools?: AiToolDeclaration[];
  /**
   * How the model picks a tool. ADR-0061 — translated per provider. If
   * `'none'` on Anthropic (which has no "none" mode), `tools` is omitted
   * from the outbound body entirely.
   */
  toolChoice?: AiToolChoice;
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
    if (options.tools !== undefined) this.validateTools(options.tools);
    if (options.toolChoice !== undefined) this.validateToolChoice(options.toolChoice);
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
   * list of {type:'text'|'image'|'tool_result', ...} parts (ADR-0060 +
   * ADR-0061). The `tool` role is the OpenAI-style tool-result turn
   * (ADR-0061). Malformed parts fail fast with AiConfigError, never
   * reaching the wire.
   */
  private static validateMessages(messages: AiMessage[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AiConfigError("AI messages must contain supported roles and string content");
    }
    for (const raw of messages) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new AiConfigError("AI messages must contain supported roles and string content");
      }
      const message = raw as Record<string, unknown>;
      const role = message.role;
      if (role === "tool") {
        if (typeof message.tool_call_id !== "string" || message.tool_call_id.length === 0) {
          throw new AiConfigError("AI tool message requires a non-empty string 'tool_call_id'");
        }
        if (typeof message.content !== "string") {
          throw new AiConfigError("AI tool message requires a string 'content'");
        }
        continue;
      }
      if (role !== "system" && role !== "user" && role !== "assistant") {
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
    for (const part of content) this.validateContentPart(part);
  }

  private static validateContentPart(part: unknown): void {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new AiConfigError("AI content part must be an object with type and text/source");
    }
    const record = part as Record<string, unknown>;
    switch (record.type) {
      case "text":
        this.validateTextPart(record);
        return;
      case "image":
        this.validateImagePart(record);
        return;
      case "tool_result":
        this.validateToolResultPart(record);
        return;
      default:
        throw new AiConfigError(`AI content part has unknown type '${String(record.type)}'`);
    }
  }

  private static validateTextPart(record: Record<string, unknown>): void {
    if (typeof record.text !== "string") throw new AiConfigError("AI text content part requires a string 'text' field");
  }

  private static validateImagePart(record: Record<string, unknown>): void {
    const source = record.source;
    if (typeof source !== "string" || source.length === 0) {
      throw new AiConfigError("AI image content part requires a non-empty string 'source' field");
    }
    if (!source.startsWith("data:") && !source.startsWith("https://")) {
      throw new AiConfigError("AI image source must be a data: URI or an https:// URL");
    }
    if (source.startsWith("data:") && !/^data:[^;,\s]+;base64,[A-Za-z0-9+/=]+$/.test(source)) {
      throw new AiConfigError("AI image data URI must be data:<media_type>;base64,<payload>");
    }
  }

  private static validateToolResultPart(record: Record<string, unknown>): void {
    if (typeof record.tool_use_id !== "string" || record.tool_use_id.length === 0) {
      throw new AiConfigError("AI tool_result part requires a non-empty string 'tool_use_id'");
    }
    if (typeof record.content !== "string") throw new AiConfigError("AI tool_result part requires a string 'content'");
  }

  /**
   * Validate the outbound tool declarations (ADR-0061). Each tool needs a
   * non-empty `name`, a string `description`, and a JSON-Schema-shaped
   * `parameters` object. Malformed tools fail fast with AiConfigError,
   * never reaching the wire.
   */
  private static validateTools(tools: unknown): void {
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new AiConfigError("AI tools must be a non-empty list of {name, description, parameters}");
    }
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        throw new AiConfigError("AI tool must be an object with name, description, parameters");
      }
      const record = tool as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) {
        throw new AiConfigError("AI tool requires a non-empty string 'name'");
      }
      if (typeof record.description !== "string") {
        throw new AiConfigError("AI tool requires a string 'description'");
      }
      if (!record.parameters || typeof record.parameters !== "object" || Array.isArray(record.parameters)) {
        throw new AiConfigError("AI tool requires a JSON-Schema object 'parameters'");
      }
    }
  }

  /**
   * Validate the outbound tool_choice value (ADR-0061). The four accepted
   * shapes are 'auto', 'none', 'required', and {name: 'x'}.
   */
  private static validateToolChoice(choice: unknown): void {
    if (typeof choice === "string") {
      if (choice !== "auto" && choice !== "none" && choice !== "required") {
        throw new AiConfigError("AI toolChoice string must be 'auto', 'none', or 'required'");
      }
      return;
    }
    if (choice && typeof choice === "object" && !Array.isArray(choice)) {
      const record = choice as Record<string, unknown>;
      if (typeof record.name !== "string" || record.name.length === 0) {
        throw new AiConfigError("AI toolChoice object requires a non-empty string 'name'");
      }
      return;
    }
    throw new AiConfigError("AI toolChoice must be 'auto'|'none'|'required' or {name: string}");
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
   * list plus optional tool declarations (ADR-0060 + ADR-0061).
   *
   * Content parts translate per provider:
   *   - OpenAI/local: image → {type:'image_url', image_url:{url}}
   *   - Anthropic:    image → {type:'image', source:{type:'base64'|'url', ...}}
   * String content is preserved verbatim in the OpenAI/local shape and
   * likewise for Anthropic (both accept a bare string).
   *
   * Tool-result turns are normalised to the current provider's expected
   * shape (either the OpenAI `{role:"tool", tool_call_id, content}` turn or
   * the Anthropic `{role:"user", content:[{type:"tool_result", ...}]}`
   * turn), so an agent-loop written against Tina4 never has to fork on
   * TINA4_AI_PROVIDER (ADR-0061 wire translation).
   */
  private static chatBody(config: Config, messages: AiMessage[], options: AiChatOptions): Record<string, unknown> {
    const normalized = this.normalizeMessagesForProvider(messages, config.provider);
    const body: Record<string, unknown> = { model: config.model, messages: normalized, stream: options.stream ?? false };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (config.provider === "anthropic") {
      const systemParts: string[] = [];
      for (const message of messages) {
        if (message.role !== "system") continue;
        const content = message.content;                                        // narrowed away from tool variant
        systemParts.push(typeof content === "string" ? content : this.contentToPlainText(content));
      }
      body.messages = normalized.filter((message) => message.role !== "system");
      body.max_tokens = options.maxTokens ?? 1024;
      if (systemParts.length) body.system = systemParts.join("\n\n");
    }
    this.applyTools(body, config.provider, options);
    return body;
  }

  /**
   * Normalise the Tina4-shaped messages into the provider's on-wire shape.
   * The `tool` role and the `tool_result` content part are translated
   * between the OpenAI and Anthropic forms so either input works against
   * either provider (ADR-0061 return-path table).
   */
  private static normalizeMessagesForProvider(messages: AiMessage[], provider: Config["provider"]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      if (message.role === "tool") {
        // OpenAI-style tool-result turn. Passthrough on OpenAI/local;
        // translate to Anthropic's user-turn form on Anthropic.
        if (provider === "anthropic") {
          out.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }],
          });
        } else {
          out.push({ role: "tool", tool_call_id: message.tool_call_id, content: message.content });
        }
        continue;
      }
      if (Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result")) {
        // Anthropic-style tool-result turn inside a user message.
        // Passthrough on Anthropic; on OpenAI/local, split each tool_result
        // part into its own {role:'tool', ...} turn.
        if (provider === "anthropic") {
          out.push({ role: message.role, content: this.translateContent(message.content, provider) });
        } else {
          for (const part of message.content) {
            if (part.type === "tool_result") {
              out.push({ role: "tool", tool_call_id: part.tool_use_id, content: part.content });
            }
          }
        }
        continue;
      }
      out.push({ role: message.role, content: this.translateContent(message.content, provider) });
    }
    return out;
  }

  /**
   * Attach the outbound `tools` and `tool_choice` (ADR-0061 outbound
   * translation tables) to the body in place. When toolChoice is 'none'
   * on Anthropic (Anthropic has no "none" mode) the tools list is omitted
   * entirely — the model cannot call what it cannot see.
   */
  private static applyTools(body: Record<string, unknown>, provider: Config["provider"], options: AiChatOptions): void {
    const choice = options.toolChoice;
    const suppressToolsForAnthropic = provider === "anthropic" && choice === "none";
    if (options.tools !== undefined && !suppressToolsForAnthropic) {
      body.tools = options.tools.map((tool) =>
        provider === "anthropic"
          ? { name: tool.name, description: tool.description, input_schema: tool.parameters }
          : { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } },
      );
    }
    if (choice === undefined) return;
    if (provider === "anthropic") {
      if (choice === "none") return;                                            // omit tools + tool_choice
      if (choice === "auto") body.tool_choice = { type: "auto" };
      else if (choice === "required") body.tool_choice = { type: "any" };
      else body.tool_choice = { type: "tool", name: choice.name };
    } else {
      if (typeof choice === "string") body.tool_choice = choice;                 // 'auto' | 'none' | 'required'
      else body.tool_choice = { type: "function", function: { name: choice.name } };
    }
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
        if (part.type === "tool_result") return { type: "tool_result", tool_use_id: part.tool_use_id, content: part.content };
        if (part.source.startsWith("data:")) {
          const parsed = this.parseDataUri(part.source);
          return { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } };
        }
        return { type: "image", source: { type: "url", url: part.source } };
      });
    }
    return content.map((part) => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "tool_result") {
        // Reached only when a non-tool_result part sits next to a
        // tool_result in a user message on OpenAI/local; the tool_result
        // parts are split out by normalizeMessagesForProvider(), so this
        // branch is a safe no-op fallback.
        return { type: "text", text: part.content };
      }
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
    yield* this.consumeOpenAiContent(delta);
    yield* this.consumeOpenAiTools(delta);
    this.updateOpenAiFinishReason(choice);
    this.updateOpenAiUsage(payload);
  }

  private *consumeAnthropic(payload: Record<string, unknown>): Iterable<AiEvent> {
    switch (payload.type) {
      case "content_block_start":
        this.consumeAnthropicBlockStart(payload);
        return;
      case "content_block_delta":
        yield* this.consumeAnthropicBlockDelta(payload);
        return;
      case "content_block_stop":
        yield* this.consumeAnthropicBlockStop(payload);
        return;
      case "message_delta":
        this.consumeAnthropicMessageDelta(payload);
        return;
      case "message_stop":
        yield* this.consumeAnthropicMessageStop();
        return;
      case "message_start":
        this.consumeAnthropicMessageStart(payload);
        return;
      case "error":
        this.consumeAnthropicError(payload);
        return;
    }
  }

  private *consumeOpenAiContent(delta: Record<string, unknown>): Iterable<AiEvent> {
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) yield { type: "text_delta", text: content };
  }

  private *consumeOpenAiTools(delta: Record<string, unknown>): Iterable<AiEvent> {
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls) yield* this.consumeOpenAiTool(call);
  }

  private *consumeOpenAiTool(call: Record<string, unknown>): Iterable<AiEvent> {
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
    if (!existing.name || !existing.args) return;
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

  private updateOpenAiFinishReason(choice: Record<string, unknown>): void {
    if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) this.lastFinishReason = choice.finish_reason;
  }

  private updateOpenAiUsage(payload: Record<string, unknown>): void {
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") return;
    const promptTokens = Number(usage.prompt_tokens ?? 0);
    const completionTokens = Number(usage.completion_tokens ?? 0);
    const totalTokens = Number(usage.total_tokens ?? promptTokens + completionTokens);
    if (Number.isFinite(promptTokens) && Number.isFinite(completionTokens)) this.lastUsage = { promptTokens, completionTokens, totalTokens };
  }

  private consumeAnthropicBlockStart(payload: Record<string, unknown>): void {
    const block = (payload.content_block ?? {}) as Record<string, unknown>;
    if (block.type !== "tool_use") return;
    const index = String(payload.index ?? this.toolBuffers.size);
    const id = typeof block.id === "string" ? block.id : `call_${index}`;
    const name = typeof block.name === "string" ? block.name : "";
    this.toolBuffers.set(index, { id, name, args: "" });
  }

  private *consumeAnthropicBlockDelta(payload: Record<string, unknown>): Iterable<AiEvent> {
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
  }

  private *consumeAnthropicBlockStop(payload: Record<string, unknown>): Iterable<AiEvent> {
    const index = String(payload.index ?? 0);
    const existing = this.toolBuffers.get(index);
    if (!existing || !existing.name) return;
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

  private consumeAnthropicMessageDelta(payload: Record<string, unknown>): void {
    const delta = (payload.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.stop_reason === "string" && delta.stop_reason.length > 0) this.lastFinishReason = delta.stop_reason;
    const usage = (payload.usage ?? {}) as Record<string, unknown>;
    if (usage.output_tokens === undefined && usage.input_tokens === undefined) return;
    const promptTokens = Number(usage.input_tokens ?? this.lastUsage?.promptTokens ?? 0);
    const completionTokens = Number(usage.output_tokens ?? this.lastUsage?.completionTokens ?? 0);
    this.lastUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  private *consumeAnthropicMessageStop(): Iterable<AiEvent> {
    if (this.doneEmitted) return;
    this.doneEmitted = true;
    yield { type: "done", finishReason: this.lastFinishReason ?? "end_turn", ...(this.lastUsage ? { usage: this.lastUsage } : {}) };
  }

  private consumeAnthropicMessageStart(payload: Record<string, unknown>): void {
    const message = (payload.message ?? {}) as Record<string, unknown>;
    const usage = (message.usage ?? {}) as Record<string, unknown>;
    if (usage.input_tokens === undefined && usage.output_tokens === undefined) return;
    const promptTokens = Number(usage.input_tokens ?? 0);
    const completionTokens = Number(usage.output_tokens ?? 0);
    this.lastUsage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
  }

  private consumeAnthropicError(payload: Record<string, unknown>): void {
    const err = (payload.error ?? {}) as Record<string, unknown>;
    throw new AiParseError(typeof err.message === "string" ? err.message : "AI provider signalled a stream error");
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
