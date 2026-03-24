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
  tReq.files = [];

  // Determine client IP with X-Forwarded-For support
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    tReq.ip = forwarded.split(",")[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    tReq.ip = forwarded[0].split(",")[0].trim();
  } else {
    tReq.ip = req.socket?.remoteAddress ?? "127.0.0.1";
  }

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

  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return;

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
function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; files: UploadedFile[] } {
  const fields: Record<string, string> = {};
  const files: UploadedFile[] = [];

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
      // File upload — standardised format: filename, type, content (base64), size
      const rawData = Buffer.from(content);
      const fileType = partContentType ?? "application/octet-stream";
      files.push({
        fieldName: disposition.name,
        filename: disposition.filename,
        type: fileType,
        content: rawData.toString("base64"),
        size: content.length,
        // Legacy aliases
        contentType: fileType,
        data: rawData,
      });
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
