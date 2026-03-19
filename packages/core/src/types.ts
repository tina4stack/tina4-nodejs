import type { IncomingMessage, ServerResponse } from "node:http";

export interface Tina4Request extends IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface Tina4Response extends ServerResponse {
  json(data: unknown): void;
  html(content: string): void;
  status(code: number): Tina4Response;
  send(data: unknown): void;
  redirect(url: string, code?: number): void;
  render?(template: string, data?: Record<string, unknown>): void;
}

export type RouteHandler = (req: Tina4Request, res: Tina4Response) => Promise<void> | void;

export interface RouteDefinition {
  method: string;
  pattern: string;
  handler: RouteHandler;
  filePath?: string;
  meta?: RouteMeta;
}

export interface RouteMeta {
  summary?: string;
  description?: string;
  tags?: string[];
  responses?: Record<string, { description: string }>;
}

export interface Tina4Config {
  port?: number;
  routesDir?: string;
  modelsDir?: string;
  templatesDir?: string;
  staticDir?: string;
  database?: {
    type?: "sqlite" | "postgres" | "mysql";
    path?: string;
    url?: string;
  };
}

export type Middleware = (
  req: Tina4Request,
  res: Tina4Response,
  next: () => void
) => void | Promise<void>;
