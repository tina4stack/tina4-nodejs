import type { IncomingMessage } from "node:http";
import type { Tina4Request, UploadedFile } from "./types.js";

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
  tReq.files = {};
  tReq.contentType = (req.headers["content-type"] ?? "") as string;

  // Parse cookies from Cookie header
  const cookieHeader = (req.headers.cookie ?? "") as string;
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const [k, ...v] = pair.trim().split("=");
      if (k) cookies[k.trim()] = v.join("=").trim();
    }
  }
  tReq.cookies = cookies;

  // Determine client IP with X-Forwarded-For support
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    tReq.ip = forwarded.split(",")[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    tReq.ip = forwarded[0].split(",")[0].trim();
  } else {
    tReq.ip = req.socket?.remoteAddress ?? "127.0.0.1";
  }

  // Add convenience methods
  tReq.header = function (name: string): string | undefined {
    const val = req.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
  };

  tReq.bearerToken = function (): string | null {
    const auth = tReq.header("authorization") ?? "";
    if (auth.toLowerCase().startsWith("bearer ")) {
      return auth.slice(7);
    }
    return null;
  };

  tReq.param = function (key: string, defaultValue?: string): string | undefined {
    return tReq.params[key] ?? tReq.query[key] ?? defaultValue;
  };

  tReq.parseBody = function (): Promise<void> {
    return parseBody(tReq);
  };

  return tReq;
}

/** Maximum upload size in bytes (default 10 MB). Override via TINA4_MAX_UPLOAD_SIZE env var. */
const TINA4_MAX_UPLOAD_SIZE = parseInt(process.env.TINA4_MAX_UPLOAD_SIZE ?? "10485760", 10);

export class PayloadTooLargeError extends Error {
  public statusCode = 413;
  constructor(actual: number, limit: number) {
    super(`Request body (${actual} bytes) exceeds TINA4_MAX_UPLOAD_SIZE (${limit} bytes)`);
    this.name = "PayloadTooLargeError";
  }
}

async function parseBody(req: Tina4Request): Promise<void> {
  const method = req.method?.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  // Check content-length header against upload size limit before reading body
  const declaredLength = parseInt(req.headers["content-length"] ?? "0", 10);
  if (declaredLength > TINA4_MAX_UPLOAD_SIZE) {
    throw new PayloadTooLargeError(declaredLength, TINA4_MAX_UPLOAD_SIZE);
  }

  const contentType = req.headers["content-type"] ?? "";
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", resolve);
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return;

  // Check actual body size against upload size limit
  if (raw.length > TINA4_MAX_UPLOAD_SIZE) {
    throw new PayloadTooLargeError(raw.length, TINA4_MAX_UPLOAD_SIZE);
  }

  if (contentType.includes("multipart/form-data")) {
    const boundary = extractBoundary(contentType);
    if (boundary) {
      const { fields, files } = parseMultipart(raw, boundary);
      req.body = fields;
      req.files = files;
    } else {
      req.body = raw.toString("utf-8");
    }
  } else if (contentType.includes("application/json")) {
    const str = raw.toString("utf-8");
    try {
      req.body = JSON.parse(str);
    } catch {
      req.body = str;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const str = raw.toString("utf-8");
    const params = new URLSearchParams(str);
    const obj: Record<string, string> = {};
    for (const [key, value] of params) {
      obj[key] = value;
    }
    req.body = obj;
  } else {
    req.body = raw.toString("utf-8");
  }
}

/**
 * Extract the boundary string from a multipart content-type header.
 */
function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Parse multipart/form-data body into fields and files.
 * Zero-dependency implementation.
 */
export function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; files: Record<string, UploadedFile | UploadedFile[]> } {
  const fields: Record<string, string> = {};
  const files: Record<string, UploadedFile | UploadedFile[]> = {};

  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelimiter = Buffer.from(`--${boundary}--`);
  const crlf = Buffer.from("\r\n");
  const doubleCrlf = Buffer.from("\r\n\r\n");

  let offset = 0;

  // Find first delimiter
  const firstIdx = bufferIndexOf(body, delimiter, offset);
  if (firstIdx === -1) return { fields, files };
  offset = firstIdx + delimiter.length;

  // Skip CRLF after delimiter
  if (body[offset] === 0x0d && body[offset + 1] === 0x0a) {
    offset += 2;
  }

  while (offset < body.length) {
    // Find the end of headers (double CRLF)
    const headersEnd = bufferIndexOf(body, doubleCrlf, offset);
    if (headersEnd === -1) break;

    const headersStr = body.subarray(offset, headersEnd).toString("utf-8");
    offset = headersEnd + doubleCrlf.length;

    // Find next delimiter
    const nextDelimIdx = bufferIndexOf(body, delimiter, offset);
    if (nextDelimIdx === -1) break;

    // Content data is between current offset and nextDelimIdx - CRLF
    const contentEnd = nextDelimIdx - crlf.length;
    const content = body.subarray(offset, contentEnd);

    // Parse headers
    const disposition = parseDisposition(headersStr);
    const partContentType = parsePartContentType(headersStr);

    if (disposition.filename) {
      // File upload — standardised format: filename, type, content (raw bytes), size
      const file: UploadedFile = {
        fieldName: disposition.name,
        filename: disposition.filename,
        type: partContentType ?? "application/octet-stream",
        content: Buffer.from(content),
        size: content.length,
      };
      // Dict keyed by field name — multiple files under same name become array
      if (files[disposition.name]) {
        const existing = files[disposition.name];
        files[disposition.name] = Array.isArray(existing) ? [...existing, file] : [existing, file];
      } else {
        files[disposition.name] = file;
      }
    } else if (disposition.name) {
      // Regular field
      fields[disposition.name] = content.toString("utf-8");
    }

    // Move past the delimiter
    offset = nextDelimIdx + delimiter.length;

    // Check for close delimiter
    if (body[offset] === 0x2d && body[offset + 1] === 0x2d) {
      // "--" means end of multipart
      break;
    }

    // Skip CRLF after delimiter
    if (body[offset] === 0x0d && body[offset + 1] === 0x0a) {
      offset += 2;
    }
  }

  return { fields, files };
}

function bufferIndexOf(haystack: Buffer, needle: Buffer, offset: number): number {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

function parseDisposition(headers: string): { name: string; filename?: string } {
  const nameMatch = headers.match(/name="([^"]+)"/);
  const filenameMatch = headers.match(/filename="([^"]+)"/);
  return {
    name: nameMatch?.[1] ?? "",
    filename: filenameMatch?.[1],
  };
}

function parsePartContentType(headers: string): string | null {
  const match = headers.match(/Content-Type:\s*(.+?)(?:\r?\n|$)/i);
  return match?.[1]?.trim() ?? null;
}
