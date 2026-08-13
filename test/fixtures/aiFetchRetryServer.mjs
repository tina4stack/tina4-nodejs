// A REAL HTTP server that answers a scripted sequence, run as a SEPARATE OS
// process (not an in-process http.createServer()) for a specific reason:
// downloadSkillsSync() (packages/core/src/ai.ts) fetches through a BLOCKING
// child.execFileSync() call, which freezes the CALLING process's event loop
// until the child exits. An in-process server sharing that same event loop
// (the pattern test/api.test.ts uses for the async Api client) would never
// get to accept the connection — the parent can't service a socket while its
// own event loop is frozen waiting on execFileSync. A genuinely separate
// process keeps its own event loop running regardless of what the test
// process is blocked on.
//
// Usage:  node aiFetchRetryServer.mjs <port>   (0 = pick any free port)
//
// Routes:
//   GET /skill        -> hit 1: 503 "down"; hit 2+: 200 "skill body"
//   GET /missing      -> always 404 "not found"
//   GET /hits?path=P  -> {"hits": N} for path P (a REAL follow-up HTTP read,
//                        not stdout-scraping — the parent test's own process
//                        can call this normally once downloadSkillsSync's
//                        blocking execFileSync() call has returned control;
//                        never counted as a hit itself)
//
// Also prints "READY <port>" once listening.

import http from "node:http";

const port = Number(process.argv[2] || 0);
const hits = {};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/hits") {
    const key = url.searchParams.get("path") || "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hits: hits[key] || 0 }));
    return;
  }

  hits[path] = (hits[path] || 0) + 1;
  const n = hits[path];

  if (path === "/skill") {
    if (n === 1) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("down");
    } else {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("skill body");
    }
    return;
  }

  if (path === "/missing") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("no such route: " + path);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`READY ${server.address().port}`);
});
