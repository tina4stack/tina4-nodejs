/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api } from '../packages/core/src/api.ts';

let passed = 0, failed = 0;
function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}
const makeOrigin = async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/seed') res.setHeader('set-cookie', 'session=synthetic-session; Path=/');
      res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null, marker: req.headers['x-marker'] ?? null }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` };
};
const a = await makeOrigin(), b = await makeOrigin();
const dir = mkdtempSync(join(tmpdir(), 'tina4-api-origin-'));
try {
  for (const credentials of ['token', 'headers', 'jar']) {
    const api = new Api(a.url, {
      authHeader: credentials === 'token' ? 'Bearer synthetic-origin-token' : '',
      headers: credentials === 'headers' ? { aUtHoRiZaTiOn: 'Bearer synthetic-header-token', cOoKiE: 'session=synthetic-header', 'X-Marker': 'kept' } : { 'X-Marker': 'kept' },
      cookies: credentials === 'jar',
    });
    if (credentials === 'jar') await api.get('/seed');
    for (const method of ['get', 'post', 'upload', 'download', 'stream']) {
      for (const offOrigin of [true, false]) {
        const path = offOrigin ? b.url + '/echo' : '/echo';
        let body: any;
        if (method === 'upload') body = (await api.upload(path, { fileBytes: 'payload', filename: 'sample.txt' })).body;
        else if (method === 'download') {
          const file = join(dir, 'download.json');
          const result = await api.download(path, file);
          if (result.http_code !== 200) throw new Error('Download failed');
          body = JSON.parse(readFileSync(file, 'utf8'));
        } else if (method === 'stream') {
          const chunks: Uint8Array[] = [];
          for await (const chunk of api.streamBytes(path)) chunks.push(chunk);
          body = JSON.parse(Buffer.concat(chunks).toString());
        } else body = (await api.sendRequest(method.toUpperCase(), path)).body;
        check(`final target credentials on every http path: ${method} ${credentials}: ${offOrigin ? 'off-origin credentials stripped' : 'same-origin credentials retained'}`,
          body.marker === 'kept' && (offOrigin ? body.authorization === null && body.cookie === null : credentials === 'jar' ? body.cookie !== null : body.authorization !== null));
      }
    }
    // Per-call header merges must not reopen the boundary.
    for (const method of ['upload', 'stream']) {
      let body: any;
      const headers = { aUtHoRiZaTiOn: 'Bearer synthetic-override', cOoKiE: 'session=synthetic-override' };
      if (method === 'upload') body = (await api.upload(b.url + '/echo', { fileBytes: 'payload', headers })).body;
      else { const chunks: Uint8Array[] = []; for await (const c of api.streamBytes(b.url + '/echo', { headers })) chunks.push(c); body = JSON.parse(Buffer.concat(chunks).toString()); }
      check(`final target credentials on every http path: ${method} off-origin per-call credentials stripped`, body.authorization === null && body.cookie === null);
    }
  }
} finally {
  await Promise.all([a.server, b.server].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
