import type { ServerResponse } from "node:http";
import type { Tina4Response } from "./types.js";

export function createResponse(res: ServerResponse): Tina4Response {
  const tRes = res as Tina4Response;

  tRes.json = function (data: unknown): void {
    this.setHeader("Content-Type", "application/json");
    this.end(JSON.stringify(data));
  };

  tRes.html = function (content: string): void {
    this.setHeader("Content-Type", "text/html; charset=utf-8");
    this.end(content);
  };

  tRes.status = function (code: number): Tina4Response {
    this.statusCode = code;
    return this;
  };

  tRes.send = function (data: unknown): void {
    if (typeof data === "string") {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      this.end(data);
    } else if (Buffer.isBuffer(data)) {
      if (!this.getHeader("Content-Type")) {
        this.setHeader("Content-Type", "application/octet-stream");
      }
      this.end(data);
    } else {
      this.json(data);
    }
  };

  tRes.redirect = function (url: string, code?: number): void {
    this.statusCode = code ?? 302;
    this.setHeader("Location", url);
    this.end();
  };

  return tRes;
}
