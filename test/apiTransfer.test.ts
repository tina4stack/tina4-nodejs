/**
 * Real (no-mock) tests for the Api transfer features added for cross-framework
 * parity with Python master: multipart upload, streaming download, the
 * injectable transport seam, the opt-in cookie jar, and redirect following with
 * the cross-origin Authorization/Cookie strip.
 *
 * Every test stands up a REAL local http.Server on 127.0.0.1:0 and does a real
 * round-trip — no doubles, no canned responses. The transport-seam test injects
 * a REAL alternate transport that performs real socket I/O (not a fake), which
 * is the only kind of injection the no-mock rule permits in the framework suite.
 *
 * Run with: npx tsx test/apiTransfer.test.ts
 */
import { Api } from "../packages/core/src/api.ts";
import type { ApiTransport } from "../packages/core/src/api.ts";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
    if (condition) {
        console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
        pass++;
    } else {
        console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
        fail++;
    }
}

// ── Real local server helpers ────────────────────────────────────────────

interface RunningServer {
    port: number;
    close: () => Promise<void>;
}

async function startServer(handler: http.RequestListener): Promise<RunningServer> {
    const server = http.createServer(handler);
    const port: number = await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Read the full request body into a Buffer. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
    });
}

/** Split a Buffer on a separator Buffer (binary-safe). */
function splitBuffer(buf: Buffer, sep: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    let idx: number;
    while ((idx = buf.indexOf(sep, start)) !== -1) {
        out.push(buf.subarray(start, idx));
        start = idx + sep.length;
    }
    out.push(buf.subarray(start));
    return out;
}

/** Parse a multipart/form-data body from the RAW bytes the client sent. */
function parseMultipart(body: Buffer, contentType: string): {
    fields: Record<string, string>;
    files: Record<string, { filename: string; contentType: string; content: Buffer }>;
} {
    const fields: Record<string, string> = {};
    const files: Record<string, { filename: string; contentType: string; content: Buffer }> = {};
    const bm = /boundary=(.+)$/.exec(contentType);
    if (!bm) return { fields, files };
    const sep = Buffer.from(`--${bm[1]}`);
    const headerSep = Buffer.from("\r\n\r\n");
    for (const seg of splitBuffer(body, sep)) {
        if (seg.length === 0) continue;
        // closing delimiter segment is "--\r\n"
        if (seg[0] === 0x2d && seg[1] === 0x2d) continue;
        let part = seg;
        if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2); // leading CRLF
        if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
            part = part.subarray(0, part.length - 2); // trailing CRLF the builder appended
        }
        const headerEnd = part.indexOf(headerSep);
        if (headerEnd === -1) continue;
        const headerText = part.subarray(0, headerEnd).toString("utf-8");
        const content = part.subarray(headerEnd + 4);
        const nameMatch = /name="([^"]*)"/.exec(headerText);
        const fileMatch = /filename="([^"]*)"/.exec(headerText);
        const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
        const name = nameMatch ? nameMatch[1] : "";
        if (fileMatch) {
            files[name] = { filename: fileMatch[1], contentType: ctMatch ? ctMatch[1].trim() : "", content };
        } else {
            fields[name] = content.toString("utf-8");
        }
    }
    return { fields, files };
}

/** Echo handler: report the auth/cookie/path the server actually saw. */
function makeEcho(label: string): http.RequestListener {
    return (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                server: label,
                authorization: req.headers.authorization ?? null,
                cookie: req.headers.cookie ?? null,
                path: req.url,
            }),
        );
    };
}

function tmpFile(name: string): string {
    return join(tmpdir(), `tina4-apixfer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

async function unlinkQuiet(path: string): Promise<void> {
    try {
        await fsp.unlink(path);
    } catch {
        /* already gone */
    }
}

console.log("=== Api Transfer Tests (upload / download / transport / cookies / redirect) ===\n");

// ── (1) upload a real file: server receives exact bytes + fields ──────────
{
    let received: { method: string; contentType: string; body: Buffer } | null = null;
    const srv = await startServer(async (req, res) => {
        const body = await readBody(req);
        received = { method: req.method ?? "", contentType: req.headers["content-type"] ?? "", body };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });

    // Binary source bytes (0..255 repeated) written to a real file with a .png name.
    const source = Buffer.alloc(4096);
    for (let i = 0; i < source.length; i++) source[i] = i % 256;
    const filePath = tmpFile("me.png");
    await fsp.writeFile(filePath, source);

    const api = new Api(`http://127.0.0.1:${srv.port}`);
    const r = await api.upload("/avatars", {
        filePath,
        extraFields: { user_id: "42", note: "hello world" },
    });
    await srv.close();
    await unlinkQuiet(filePath);

    assert("(1) upload file: got 200", r.http_code === 200, JSON.stringify(r));
    assert("(1) upload file: POST method", received!.method === "POST", received?.method);
    assert(
        "(1) upload file: content-type is multipart with 32-hex Tina4 boundary",
        /^multipart\/form-data; boundary=----Tina4Boundary[0-9a-f]{32}$/.test(received!.contentType),
        received?.contentType,
    );

    const parsed = parseMultipart(received!.body, received!.contentType);
    assert("(1) upload file: extra field user_id", parsed.fields.user_id === "42", parsed.fields.user_id);
    assert("(1) upload file: extra field note", parsed.fields.note === "hello world", parsed.fields.note);
    assert("(1) upload file: default field name is 'file'", !!parsed.files.file);
    assert(
        "(1) upload file: filename defaults to the file's basename",
        parsed.files.file?.filename === basename(filePath),
        `${parsed.files.file?.filename} vs ${basename(filePath)}`,
    );
    assert(
        "(1) upload file: part Content-Type guessed image/png from .png",
        parsed.files.file?.contentType === "image/png",
        parsed.files.file?.contentType,
    );
    assert(
        "(1) upload file: server received the EXACT source bytes",
        !!parsed.files.file && Buffer.compare(parsed.files.file.content, source) === 0,
        `len ${parsed.files.file?.content.length} vs ${source.length}`,
    );
}

// ── (2) in-memory upload variant (fileBytes + filename, custom field) ─────
{
    let received: { contentType: string; body: Buffer } | null = null;
    const srv = await startServer(async (req, res) => {
        const body = await readBody(req);
        received = { contentType: req.headers["content-type"] ?? "", body };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });

    const bytes = Buffer.from("in-memory payload, no temp file needed", "utf-8");
    const api = new Api(`http://127.0.0.1:${srv.port}`);
    const r = await api.upload("/docs", { fileBytes: bytes, filename: "data.txt", fieldName: "upload" });
    await srv.close();

    assert("(2) in-memory upload: got 200", r.http_code === 200, JSON.stringify(r));
    const parsed = parseMultipart(received!.body, received!.contentType);
    assert("(2) in-memory upload: custom field name 'upload'", !!parsed.files.upload);
    assert("(2) in-memory upload: filename data.txt", parsed.files.upload?.filename === "data.txt", parsed.files.upload?.filename);
    assert(
        "(2) in-memory upload: part Content-Type text/plain from .txt",
        parsed.files.upload?.contentType === "text/plain",
        parsed.files.upload?.contentType,
    );
    assert(
        "(2) in-memory upload: server received exact in-memory bytes",
        !!parsed.files.upload && Buffer.compare(parsed.files.upload.content, bytes) === 0,
    );
}

// ── (3) content-type fallback: unknown extension -> octet-stream ──────────
{
    let received: { contentType: string; body: Buffer } | null = null;
    const srv = await startServer(async (req, res) => {
        const body = await readBody(req);
        received = { contentType: req.headers["content-type"] ?? "", body };
        res.writeHead(200);
        res.end("ok");
    });

    const api = new Api(`http://127.0.0.1:${srv.port}`);
    // No filename -> defaults to "upload.bin"; .bin is not in the map -> octet-stream.
    await api.upload("/blobs", { fileBytes: Buffer.from([1, 2, 3, 4]) });
    await srv.close();

    const parsed = parseMultipart(received!.body, received!.contentType);
    assert("(3) fallback: default name upload.bin", parsed.files.file?.filename === "upload.bin", parsed.files.file?.filename);
    assert(
        "(3) fallback: unknown ext part Content-Type is application/octet-stream",
        parsed.files.file?.contentType === "application/octet-stream",
        parsed.files.file?.contentType,
    );
}

// ── (4) upload negatives: missing file / no source -> clean error, no send ─
{
    const requests: string[] = [];
    const srv = await startServer((req, res) => {
        requests.push(req.url ?? "");
        res.writeHead(200);
        res.end("ok");
    });

    const api = new Api(`http://127.0.0.1:${srv.port}`);
    const missing = await api.upload("/x", { filePath: "/definitely/not/here/nope.bin" });
    const noSource = await api.upload("/x", {});
    await srv.close();

    assert("(4) missing file: http_code null", missing.http_code === null, JSON.stringify(missing));
    assert("(4) missing file: error mentions 'file not found'", (missing.error ?? "").includes("file not found"), missing.error ?? "");
    assert("(4) missing file: body null", missing.body === null);
    assert("(4) no source: http_code null", noSource.http_code === null);
    assert(
        "(4) no source: error requires filePath or fileBytes",
        (noSource.error ?? "").includes("upload requires filePath or fileBytes"),
        noSource.error ?? "",
    );
    assert("(4) negatives sent ZERO requests to the server", requests.length === 0, `got ${requests.length}`);
}

// ── (5) download streams a multi-MB body to a temp file; bytes match ──────
{
    const SIZE = 3 * 1024 * 1024; // 3 MB
    const payload = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) payload[i] = (i * 31 + 7) % 256;

    const srv = await startServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(SIZE) });
        // Write in slices so the client genuinely streams chunk-by-chunk.
        let offset = 0;
        const step = 128 * 1024;
        const writeNext = () => {
            while (offset < SIZE) {
                const end = Math.min(offset + step, SIZE);
                const ok = res.write(payload.subarray(offset, end));
                offset = end;
                if (!ok) {
                    res.once("drain", writeNext);
                    return;
                }
            }
            res.end();
        };
        writeNext();
    });

    const dest = tmpFile("big.bin");
    const api = new Api(`http://127.0.0.1:${srv.port}`);
    const result = await api.download("/big", dest);
    await srv.close();

    assert("(5) download: http_code 200", result.http_code === 200, JSON.stringify({ ...result }));
    assert("(5) download: path is the destination", result.path === dest, `${result.path}`);
    assert("(5) download: error null", result.error === null);
    assert("(5) download: result has NO body field (streamed to disk)", !("body" in (result as Record<string, unknown>)));

    const onDisk = await fsp.readFile(dest);
    assert("(5) download: file size == source size", onDisk.length === SIZE, `${onDisk.length} vs ${SIZE}`);
    assert("(5) download: file bytes == source bytes", Buffer.compare(onDisk, payload) === 0);
    await unlinkQuiet(dest);
}

// ── (5b) download negatives: missing dest, HTTP error status ──────────────
{
    const srv = await startServer((_req, res) => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
    });
    const api = new Api(`http://127.0.0.1:${srv.port}`);

    const noDest = await api.download("/x", "");
    assert("(5b) download: empty dest -> http_code null + error", noDest.http_code === null && noDest.path === null && !!noDest.error);

    const dest = tmpFile("should-not-exist.bin");
    const errStatus = await api.download("/missing", dest);
    await srv.close();
    assert("(5b) download: 404 -> path null", errStatus.path === null, `${errStatus.path}`);
    assert("(5b) download: 404 -> http_code 404", errStatus.http_code === 404, `${errStatus.http_code}`);
    assert("(5b) download: 404 -> error set", !!errStatus.error);
    let wrote = true;
    try {
        await fsp.access(dest);
    } catch {
        wrote = false;
    }
    assert("(5b) download: NO file written on HTTP error", wrote === false);
    await unlinkQuiet(dest);
}

// ── (6) redirect: same-origin KEEPS Authorization + Cookie ────────────────
{
    const srv = await startServer((req, res) => {
        if (req.url === "/start") {
            res.writeHead(302, { Location: "/final" });
            res.end();
            return;
        }
        makeEcho("A")(req, res); // /final on the SAME origin
    });

    const api = new Api(`http://127.0.0.1:${srv.port}`, { bearerToken: "same-secret" });
    api.addHeaders({ Cookie: "sid=same-cookie" });
    const r = await api.get("/start");
    await srv.close();

    const body = r.body as Record<string, unknown>;
    assert("(6) same-origin redirect: followed to 200", r.http_code === 200, JSON.stringify(r));
    assert("(6) same-origin redirect: reached the same server's /final", body.server === "A" && body.path === "/final");
    assert("(6) same-origin redirect: Authorization KEPT", body.authorization === "Bearer same-secret", `${body.authorization}`);
    assert("(6) same-origin redirect: Cookie KEPT", body.cookie === "sid=same-cookie", `${body.cookie}`);
}

// ── (7) redirect: cross-origin STRIPS Authorization + Cookie ──────────────
{
    const srvB = await startServer(makeEcho("B")); // different origin (different port)
    const srvA = await startServer((req, res) => {
        if (req.url === "/start") {
            res.writeHead(302, { Location: `http://127.0.0.1:${srvB.port}/final` });
            res.end();
            return;
        }
        makeEcho("A")(req, res);
    });

    const api = new Api(`http://127.0.0.1:${srvA.port}`, { bearerToken: "cross-secret" });
    api.addHeaders({ Cookie: "sid=cross-cookie" });
    const r = await api.get("/start");
    await srvA.close();
    await srvB.close();

    const body = r.body as Record<string, unknown>;
    assert("(7) cross-origin redirect: followed to 200", r.http_code === 200, JSON.stringify(r));
    assert("(7) cross-origin redirect: landed on the OTHER origin (server B)", body.server === "B", `${body.server}`);
    assert("(7) cross-origin redirect: Authorization STRIPPED", body.authorization === null, `${body.authorization}`);
    assert("(7) cross-origin redirect: Cookie STRIPPED", body.cookie === null, `${body.cookie}`);
}

// ── (8) cookie jar: Set-Cookie captured then sent on the next request ─────
{
    const cookieSrv = await startServer((req, res) => {
        if (req.url === "/login") {
            res.writeHead(200, {
                "Content-Type": "application/json",
                // Multiple Set-Cookie headers; same name repeated -> last wins.
                "Set-Cookie": ["a=1; Path=/; HttpOnly", "b=2; Path=/", "a=3; Path=/"],
            });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        // /me — report the Cookie header the server actually received
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    });

    // Positive: cookies enabled -> jar captures Set-Cookie and replays it.
    const jarApi = new Api(`http://127.0.0.1:${cookieSrv.port}`, { cookies: true });
    await jarApi.get("/login");
    const meOn = await jarApi.get("/me");
    assert(
        "(8) cookie jar ON: accumulated Cookie sent (last-wins a=3, plus b=2)",
        (meOn.body as Record<string, unknown>).cookie === "a=3; b=2",
        `${(meOn.body as Record<string, unknown>).cookie}`,
    );

    // Negative: cookies disabled (default) -> NOTHING is sent back.
    const plainApi = new Api(`http://127.0.0.1:${cookieSrv.port}`);
    await plainApi.get("/login");
    const meOff = await plainApi.get("/me");
    await cookieSrv.close();
    assert(
        "(8) cookie jar OFF (default): no Cookie sent on the next request",
        (meOff.body as Record<string, unknown>).cookie === null,
        `${(meOff.body as Record<string, unknown>).cookie}`,
    );
}

// ── (9) transport seam: a REAL alternate transport replaces the network ───
// The injected transport does REAL socket I/O to a backend that returns a
// distinct marker; the Api's baseUrl points at a DIFFERENT reachable server.
// Getting the transport's marker back proves the seam replaced the built-in
// network path (not a canned/fake response — real sockets on both ends).
{
    const backend = await startServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "tok=xyz; Path=/" });
        res.end(JSON.stringify({ via: "custom-transport", path: req.url, method: req.method }));
    });
    const direct = await startServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ via: "direct-network", path: req.url }));
    });

    let transportCalls = 0;
    const headersSeenByTransport: Record<string, string>[] = [];
    // REAL transport: opens a real socket to `backend`, regardless of the URL
    // host it was handed. Uses node:http directly — no fake, no canned data.
    const realTransport: ApiTransport = (method, _url, headers, body) => {
        transportCalls++;
        headersSeenByTransport.push({ ...headers });
        return new Promise((resolve) => {
            const req = http.request(
                { hostname: "127.0.0.1", port: backend.port, path: "/thing", method, headers },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c: Buffer) => chunks.push(c));
                    res.on("end", () => {
                        const raw = Buffer.concat(chunks).toString("utf-8");
                        let parsed: unknown;
                        try {
                            parsed = JSON.parse(raw);
                        } catch {
                            parsed = raw;
                        }
                        const h: Record<string, string> = {};
                        for (const [k, v] of Object.entries(res.headers)) {
                            if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : v;
                        }
                        resolve({ http_code: res.statusCode ?? null, body: parsed, headers: h, error: null });
                    });
                },
            );
            req.on("error", (e) => resolve({ http_code: null, body: null, headers: {}, error: e.message }));
            if (body) req.write(body);
            req.end();
        });
    };

    // baseUrl is `direct` (reachable) but the transport serves from `backend`.
    const seamApi = new Api(`http://127.0.0.1:${direct.port}`, { transport: realTransport, cookies: true });
    const r1 = await seamApi.get("/one");
    const r2 = await seamApi.get("/two");

    assert("(9) transport seam: 200 via custom transport", r1.http_code === 200, JSON.stringify(r1));
    assert(
        "(9) transport seam: served by the transport's backend, NOT the direct baseUrl",
        (r1.body as Record<string, unknown>).via === "custom-transport",
        `${(r1.body as Record<string, unknown>).via}`,
    );
    assert("(9) transport seam: transport invoked for each request", transportCalls === 2, `got ${transportCalls}`);
    // The transport returned a real Set-Cookie -> jar stored it -> 2nd request carried it.
    assert(
        "(9) transport seam: cookie jar captured Set-Cookie from the transport result",
        headersSeenByTransport[1]?.["Cookie"] === "tok=xyz",
        `${headersSeenByTransport[1]?.["Cookie"]}`,
    );

    // Default contract: NO transport -> the real built-in network path serves
    // from the baseUrl (direct), proving the seam is opt-in and inert by default.
    const defaultApi = new Api(`http://127.0.0.1:${direct.port}`);
    const rd = await defaultApi.get("/thing");
    await backend.close();
    await direct.close();
    assert("(9) default (no transport): served by the built-in network path", (rd.body as Record<string, unknown>).via === "direct-network", JSON.stringify(rd));
    assert("(9) default (no transport): 200", rd.http_code === 200);
}

// ── (10) upload goes through retry/backoff like the verbs (503-then-200) ──
{
    let count = 0;
    const srv = await startServer(async (req, res) => {
        await readBody(req); // consume so the socket completes cleanly
        count++;
        if (count === 1) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "unavailable" }));
        } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stored: true }));
        }
    });

    const api = new Api(`http://127.0.0.1:${srv.port}`, { maxRetries: 3, retryBackoff: 0.01 });
    const r = await api.upload("/files", { fileBytes: Buffer.from("retry me"), filename: "r.txt" });
    await srv.close();

    assert("(10) upload retry: recovered a 503-then-200", r.http_code === 200, JSON.stringify(r));
    assert("(10) upload retry: exactly 2 attempts", count === 2, `got ${count}`);
    assert("(10) upload retry: body parsed", (r.body as Record<string, unknown>).stored === true);
}

// Summary
console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
