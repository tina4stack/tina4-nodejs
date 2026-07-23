/**
 * MQTT username/password auth and TLS (mqtts://) — real brokers, no mocks.
 *
 * Mirrors tina4_python tests/test_mqtt_auth_tls.py, tina4-ruby
 * spec/mqtt_auth_tls_spec.rb, and tina4-php tests/MqttAuthTlsTest.php. Broker
 * layout from plan/v3/spikes/mqtt-infra.sh:
 *
 *   1883  anonymous
 *   1884  allow_anonymous false + password_file   -> the auth tests
 *   8883  TLS, self-signed CA                      -> the mqtts tests
 *
 * The TLS tests matter more than they look. A TLS suite passes just as happily
 * with verification switched off, and then "we have TLS" quietly means "we trust
 * any certificate" — so the load-bearing assertions are the NEGATIVE ones: a
 * self-signed cert must be REJECTED when its CA is not supplied, and supplying a
 * CA for one client must not make a LATER client trust it.
 *
 * Run with: npx tsx test/mqttAuthTls.test.ts
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mqtt, MqttError } from "../packages/core/src/mqtt.ts";
import { Log } from "../packages/core/src/logger.ts";

const AUTH_URL = process.env.TINA4_TEST_MQTT_AUTH_URL || "mqtt://127.0.0.1:1884";
const TLS_URL = process.env.TINA4_TEST_MQTT_TLS_URL || "mqtts://127.0.0.1:8883";
const ANON_URL = process.env.TINA4_TEST_MQTT_URL || "mqtt://127.0.0.1:1883";
const USERNAME = process.env.TINA4_TEST_MQTT_USERNAME || "tina4";
const PASSWORD = process.env.TINA4_TEST_MQTT_PASSWORD || "testpass";

function caFile(): string | null {
  for (const name of ["TINA4_TEST_MQTT_CA_FILE", "TINA4_MQTT_TEST_CA"]) {
    const v = (process.env[name] ?? "").trim();
    if (v !== "") return v;
  }
  // Fall back to where mqtt-infra.sh writes its certs by default: its DIR is
  // $TMPDIR/tina4-mqtt-infra, the same location the Ruby helper defaults to.
  const tmp = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  const def = `${tmp}/tina4-mqtt-infra/certs/ca.crt`;
  return existsSync(def) ? def : null;
}
const CA = caFile();

let pass = 0;
let fail = 0;
let skipped = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

async function assertThrows(name: string, fn: () => Promise<unknown>, match?: RegExp | string): Promise<void> {
  try {
    await fn();
    assert(name, false, "did not throw");
  } catch (e) {
    const m = (e as Error).message;
    const ok = match === undefined ? true : match instanceof RegExp ? match.test(m) : m.includes(match);
    assert(name, ok, ok ? "" : `unexpected message: ${m}`);
  }
}

function reachable(url: string): Promise<boolean> {
  const p = Mqtt.parseUrl(url);
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: p.host, port: p.port });
    const done = (up: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(2000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function authUrlWith(user: string, pw: string): string {
  const p = Mqtt.parseUrl(AUTH_URL);
  const scheme = p.tls ? "mqtts" : "mqtt";
  const creds = `${encodeURIComponent(user)}:${encodeURIComponent(pw)}`;
  return `${scheme}://${creds}@${p.host}:${p.port}`;
}

async function main(): Promise<void> {
  const authUp = await reachable(AUTH_URL);
  const anonUp = await reachable(ANON_URL);
  const tlsUp = (await reachable(TLS_URL)) && CA !== null;

  // -- auth -------------------------------------------------------------

  if (!authUp) {
    console.log(`  \x1b[33mSKIP\x1b[0m auth tests (auth broker not reachable at ${AUTH_URL})`);
    skipped++;
  } else {
    {
      const c = await new Mqtt({ url: authUrlWith(USERNAME, PASSWORD), clientId: "tina4-node-auth-good", timeout: 5 }).connect();
      assert("auth: url credentials connect", c.connected() && c.username === USERNAME);
      const t = "tina4/nodetest/authtls/authed";
      assert("auth: subscribe over authed connection", (await c.subscribe(t, 1)) === 1);
      assert("auth: publish returns a packet id", typeof (await c.publish(t, "authenticated", 1)) === "number");
      assert("auth: round trip over authed connection", (await c.receive(3)).text() === "authenticated");
      await c.disconnect();
    }
    {
      const c = await new Mqtt({ url: AUTH_URL, clientId: "tina4-node-auth-kw", username: USERNAME, password: PASSWORD, timeout: 5 }).connect();
      assert("auth: credentials as options", c.connected());
      await c.disconnect();
    }
    {
      const wrong = authUrlWith(USERNAME, "definitely-wrong");
      const c = await new Mqtt({ url: wrong, clientId: "tina4-node-auth-override", username: USERNAME, password: PASSWORD, timeout: 5 }).connect();
      assert("auth: options win over url", c.connected());
      await c.disconnect();
    }
    await assertThrows(
      "auth: no credentials refused",
      () => new Mqtt({ url: AUTH_URL, clientId: "tina4-node-auth-nocreds", timeout: 5 }).connect(),
      /broker refused the connection.*CONNACK return code|CONNACK return code/,
    );
    await assertThrows(
      "auth: wrong password refused",
      () => new Mqtt({ url: authUrlWith(USERNAME, "wrong-password"), clientId: "tina4-node-auth-badpass", timeout: 5 }).connect(),
      /CONNACK return code [45]/,
    );
    await assertThrows(
      "auth: unknown username refused",
      () => new Mqtt({ url: authUrlWith("nobody", PASSWORD), clientId: "tina4-node-auth-baduser", timeout: 5 }).connect(),
      /CONNACK return code [45]/,
    );
  }

  if (anonUp) {
    // Credentials the broker does not need must not break the CONNECT payload.
    const c = await new Mqtt({ url: ANON_URL, clientId: "tina4-node-anon-creds", username: USERNAME, password: PASSWORD, timeout: 5 }).connect();
    assert("auth: anonymous listener accepts supplied credentials", c.connected());
    assert("auth: publish over anon-with-creds", typeof (await c.publish("tina4/nodetest/authtls/anon", "fine", 1)) === "number");
    await c.disconnect();
  } else {
    skipped++;
  }

  // -- TLS --------------------------------------------------------------

  if (!tlsUp) {
    console.log(`  \x1b[33mSKIP\x1b[0m TLS tests (TLS broker not reachable at ${TLS_URL} or CA not set)`);
    skipped++;
  } else {
    const ca = CA as string;

    {
      const c = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls", caFile: ca, timeout: 5 }).connect();
      assert("tls: connects with CA", c.connected() && c.tls());
      // Not "did it connect" but "is it actually encrypted": a negotiated cipher
      // and a TLS version can only come from a completed handshake.
      assert("tls: negotiated a real cipher", typeof c.cipher() === "string" && c.cipher() !== "");
      assert("tls: negotiated TLS 1.2/1.3", c.tlsVersion() === "TLSv1.2" || c.tlsVersion() === "TLSv1.3");
      await c.disconnect();
    }
    {
      const c = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-rt", caFile: ca, timeout: 5 }).connect();
      const t = "tina4/nodetest/authtls/over-tls";
      assert("tls: subscribe over TLS", (await c.subscribe(t, 1)) === 1);
      await c.publish(t, "over-tls", 1);
      assert("tls: round trip over TLS", (await c.receive(5)).text() === "over-tls");
      await c.disconnect();
    }
    {
      // A TLS record is at most 16 KB; a 1 MiB payload spans many records AND
      // leaves decrypted bytes buffered in the TLS layer. The 'data'-driven
      // reader reassembles it — no select()-vs-buffered-plaintext hang.
      const c = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-big", caFile: ca, timeout: 10, readTimeout: 20 }).connect();
      const t = "tina4/nodetest/authtls/tls-stream";
      await c.subscribe(t, 1);
      const payloadStr = randomBytes(524288).toString("hex"); // 1,048,576 hex chars
      await c.publish(t, payloadStr, 1);
      const got = await c.receive(20);
      assert("tls: reassembles payload > one TLS record", got.payload.length === 1048576 && got.text() === payloadStr);
      await c.disconnect();
    }
    // THE test: self-signed cert REJECTED when no CA is supplied.
    await assertThrows(
      "tls: rejects self-signed cert when no CA supplied",
      () => new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-noca", timeout: 5 }).connect(),
      /self.signed|certificate verif|unable to get local issuer/i,
    );
    // No CA leak: a CA loaded for one client must NOT be trusted by a later one.
    {
      const trusted = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-first", caFile: ca, timeout: 5 }).connect();
      assert("tls: first client (with CA) connects", trusted.connected());
      await assertThrows(
        "tls: CA does not leak into a later client",
        () => new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-second", timeout: 5 }).connect(),
      );
      await trusted.disconnect();
    }
    // reads CA from env
    {
      const prev = process.env.TINA4_MQTT_CA_FILE;
      process.env.TINA4_MQTT_CA_FILE = ca;
      try {
        const c = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-env", timeout: 5 }).connect();
        assert("tls: reads CA from env", c.connected());
        await c.disconnect();
      } finally {
        if (prev === undefined) delete process.env.TINA4_MQTT_CA_FILE;
        else process.env.TINA4_MQTT_CA_FILE = prev;
      }
    }
    // verify-off is explicit and logs loudly (assert against the real log file)
    {
      const dir = mkdtempSync(join(tmpdir(), "tina4-mqtt-log-"));
      const prevDebug = process.env.TINA4_DEBUG;
      const prevOut = process.env.TINA4_LOG_OUTPUT;
      process.env.TINA4_DEBUG = "true";
      process.env.TINA4_LOG_OUTPUT = "file";
      Log.configure({ logDir: dir, logFile: "mqtt.log" });
      try {
        const insecure = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-insecure", tlsVerify: false, timeout: 5 }).connect();
        assert("tls: verify-off connects", insecure.connected() && insecure.tls());
        const logged = readFileSync(join(dir, "mqtt.log"), "utf-8");
        assert("tls: verify-off logs 'verification is DISABLED'", logged.includes("verification is DISABLED"));
        assert("tls: verify-off logs 'man in the middle'", logged.includes("man in the middle"));
        assert("tls: verify-off logs 'TINA4_MQTT_CA_FILE'", logged.includes("TINA4_MQTT_CA_FILE"));
        await insecure.disconnect();
      } finally {
        if (prevDebug === undefined) delete process.env.TINA4_DEBUG;
        else process.env.TINA4_DEBUG = prevDebug;
        if (prevOut === undefined) delete process.env.TINA4_LOG_OUTPUT;
        else process.env.TINA4_LOG_OUTPUT = prevOut;
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // env verify flag is two-way
    {
      const prev = process.env.TINA4_MQTT_TLS_VERIFY;
      try {
        process.env.TINA4_MQTT_TLS_VERIFY = "false";
        const insecure = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-envoff", timeout: 5 }).connect();
        assert("tls: env verify=false connects insecure", insecure.connected());
        await insecure.disconnect();
        process.env.TINA4_MQTT_TLS_VERIFY = "true";
        await assertThrows(
          "tls: env verify=true is not a one-way door",
          () => new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-envon", timeout: 5 }).connect(),
        );
      } finally {
        if (prev === undefined) delete process.env.TINA4_MQTT_TLS_VERIFY;
        else process.env.TINA4_MQTT_TLS_VERIFY = prev;
      }
    }
    // missing CA file reported by path
    await assertThrows(
      "tls: missing CA file reported by path",
      () => new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-nofile", caFile: "/nonexistent/tina4-ca.crt", timeout: 5 }).connect(),
      /\/nonexistent\/tina4-ca\.crt/,
    );
    // auth + TLS on the same connection
    if (authUp) {
      const c = await new Mqtt({ url: TLS_URL, clientId: "tina4-node-tls-auth", username: USERNAME, password: PASSWORD, caFile: ca, timeout: 5 }).connect();
      assert("tls: auth + TLS on the same connection", c.connected() && c.tls());
      assert("tls: publish over auth+TLS", typeof (await c.publish("tina4/nodetest/authtls/tls-auth", "both", 1)) === "number");
      await c.disconnect();
    }
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail + 1} failed\x1b[0m`);
  process.exit(1);
});
