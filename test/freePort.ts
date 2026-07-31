/**
 * Reserve an ephemeral port and hand it back.
 *
 * Replaces `BASE + (process.pid % N)`, which several suites used. That is a
 * DETERMINISTIC port: the same pid always picks the same one, the range is
 * tiny (one suite had 8 possible values), and the ranges overlap Tina4's own
 * default serve ports (7145/7146 and +1000). It collided for real on
 * 2026-07-31 in tina4-php, where an unrelated process held the chosen port,
 * the server still reported a successful start, and the assertion failed on
 * the wrong output - costing a full suite re-run and able to mask a real
 * failure.
 *
 * Asking the OS for port 0 gets a port nothing else is on, from the ephemeral
 * range, which does not overlap the framework's defaults.
 *
 * HONEST LIMIT: this is still a reserve-then-release, so a race window exists
 * between closing the socket here and the server binding. It is not airtight -
 * nothing that returns a port NUMBER can be. It is dramatically better than a
 * pid modulo because the OS avoids handing out a port it just released, and
 * because the pool is the whole ephemeral range instead of 8 values. The
 * airtight version is to bind port 0 and read back what you got, which
 * `startServer` cannot currently do: passing `{ port: 0 }` returns 0 rather
 * than the bound port. Recorded rather than worked around.
 */
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}
