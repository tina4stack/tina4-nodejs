import type { IncomingMessage } from "node:http";
import type { Tina4Request } from "./types.js";

export function createRequest(req: IncomingMessage): Tina4Request {
  const tReq = req as Tina4Request;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  tReq.params = {};
  tReq.query = query;
  tReq.body = undefined;

  return tReq;
}

export async function parseBody(req: Tina4Request): Promise<void> {
  const method = req.method?.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const contentType = req.headers["content-type"] ?? "";
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", resolve);
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return;

  if (contentType.includes("application/json")) {
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = raw;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const obj: Record<string, string> = {};
    for (const [key, value] of params) {
      obj[key] = value;
    }
    req.body = obj;
  } else {
    req.body = raw;
  }
}
