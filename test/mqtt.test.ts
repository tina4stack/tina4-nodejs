/**
 * MQTT 3.1.1 client — real-broker tests (no mocks).
 *
 * Mirrors tina4_python tests/test_mqtt.py, tina4-ruby spec/mqtt_spec.rb, and
 * tina4-php tests/MqttTest.php. Every network test hits a REAL Eclipse Mosquitto
 * on 127.0.0.1:1883 (the anonymous listener from plan/v3/spikes/mqtt-infra.sh).
 * No test double stands in for the broker: a mock-passing MQTT test proves
 * nothing about the wire protocol, which is the whole point of a hand-rolled
 * client. Tests that need no broker (varint, url parse, QoS-2 refusal) are
 * pure-logic and use no double.
 *
 * Run with: npx tsx test/mqtt.test.ts
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Mqtt, MqttError } from "../packages/core/src/mqtt.ts";

const BROKER = "mqtt://127.0.0.1:1883";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

async function assertThrows(name: string, fn: () => Promise<unknown> | unknown, match?: RegExp | string): Promise<void> {
  try {
    await fn();
    assert(name, false, "did not throw");
  } catch (e) {
    const m = (e as Error).message;
    const ok = match === undefined ? true : match instanceof RegExp ? match.test(m) : m.includes(match);
    assert(name, ok, ok ? "" : `unexpected message: ${m}`);
  }
}

function brokerUp(host = "127.0.0.1", port = 1883): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (up: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(1000);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

function topic(suffix: string): string {
  return `tina4/nodetest/${randomBytes(4).toString("hex")}/${suffix}`;
}

async function main(): Promise<void> {
  // -- pure logic (no broker) -------------------------------------------

  assert("varint 0", Mqtt.encodeRemainingLength(0).toString("hex") === "00");
  assert("varint 127", Mqtt.encodeRemainingLength(127).toString("hex") === "7f");
  assert("varint 128 (multi-byte boundary)", Mqtt.encodeRemainingLength(128).toString("hex") === "8001");
  assert("varint 16383", Mqtt.encodeRemainingLength(16383).toString("hex") === "ff7f");
  assert("varint 268435455", Mqtt.encodeRemainingLength(268435455).toString("hex") === "ffffff7f");
  await assertThrows("varint rejects out of range", () => Mqtt.encodeRemainingLength(268435456));
  await assertThrows("varint rejects negative", () => Mqtt.encodeRemainingLength(-1));

  const plain = Mqtt.parseUrl("mqtt://host:1883");
  assert("parseUrl plain", plain.host === "host" && plain.port === 1883 && plain.tls === false && plain.username === null && plain.password === null);
  assert("parseUrl default port mqtt", Mqtt.parseUrl("mqtt://host").port === 1883);
  assert("parseUrl default port mqtts", Mqtt.parseUrl("mqtts://host").port === 8883);
  assert("parseUrl mqtts sets tls", Mqtt.parseUrl("mqtts://host").tls === true);
  const creds = Mqtt.parseUrl("mqtt://user:p%40ss%2Fword@host:1883");
  assert("parseUrl percent-decodes userinfo", creds.username === "user" && creds.password === "p@ss/word");
  assert("parseUrl + is not a space", Mqtt.parseUrl("mqtt://u:a+b@host").password === "a+b");
  const v6 = Mqtt.parseUrl("mqtt://[::1]:1883");
  assert("parseUrl ipv6 bracketed", v6.host === "::1" && v6.port === 1883);
  const lastAt = Mqtt.parseUrl("mqtt://u:pa@ss@host:1883");
  assert("parseUrl last @ wins for unencoded @ in password", lastAt.host === "host" && lastAt.password === "pa@ss");
  await assertThrows("parseUrl empty raises", () => Mqtt.parseUrl("   "));
  await assertThrows("parseUrl unsupported scheme raises", () => Mqtt.parseUrl("ws://host:9001"));

  await assertThrows("publish QoS 2 names limit + alternative", () => new Mqtt().publish("t", "x", 2), /QoS 2/);
  await assertThrows("publish QoS 2 names idempotent alternative", () => new Mqtt().publish("t", "x", 2), /idempotent/);
  await assertThrows("publish QoS 2 names device_timestamp", () => new Mqtt().publish("t", "x", 2), /device_timestamp/);
  await assertThrows("subscribe QoS 2 raises", () => new Mqtt().subscribe("t", 2));
  await assertThrows("invalid QoS raises", () => new Mqtt().publish("t", "x", 5));
  await assertThrows("password without username raises", () => Promise.resolve(new Mqtt({ url: "mqtt://host", password: "secret" })));
  assert("generates client id", new Mqtt().clientId.startsWith("tina4-"));

  // -- real broker ------------------------------------------------------

  if (!(await brokerUp())) {
    console.log("  \x1b[33mSKIP\x1b[0m live-broker tests (no MQTT broker on 127.0.0.1:1883)");
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(fail > 0 ? 1 : 0);
  }

  // connect + disconnect
  const conn = await new Mqtt({ url: BROKER, clientId: "tina4-node-conn" }).connect();
  assert("connect() opens the socket", conn.connected() === true);
  await conn.disconnect();
  assert("disconnect() closes the socket", conn.connected() === false);

  // publish QoS 0 -> null
  const p0 = await new Mqtt({ url: BROKER }).connect();
  assert("publish QoS 0 returns null", (await p0.publish(topic("q0"), "hello", 0)) === null);
  await p0.disconnect();

  // publish QoS 1 -> packet id
  const p1 = await new Mqtt({ url: BROKER }).connect();
  const pid = await p1.publish(topic("q1"), "hello", 1);
  assert("publish QoS 1 returns a packet id", typeof pid === "number" && pid! >= 1 && pid! <= 0xffff);
  await p1.disconnect();

  // subscribe -> granted QoS
  const s1 = await new Mqtt({ url: BROKER }).connect();
  assert("subscribe returns granted QoS", (await s1.subscribe(topic("sub"), 1)) === 1);
  await s1.disconnect();

  // QoS 1 round trip: topic + payload intact
  {
    const t = topic("telemetry");
    const sub = await new Mqtt({ url: BROKER, clientId: "tina4-node-sub" }).connect();
    await sub.subscribe(t, 1);
    const pub = await new Mqtt({ url: BROKER, clientId: "tina4-node-pub" }).connect();
    await pub.publish(t, '{"kwh":12.5}', 1);
    const msg = await sub.receive(5);
    assert("round trip: topic intact", msg.topic === t);
    assert("round trip: payload intact", msg.text() === '{"kwh":12.5}');
    assert("round trip: qos", msg.qos === 1);
    assert("round trip: auto-acked", msg.isAcknowledged() === true);
    await sub.disconnect();
    await pub.disconnect();
  }

  // wildcard subscription
  {
    const base = topic("dev");
    const sub = await new Mqtt({ url: BROKER, clientId: "tina4-node-wild" }).connect();
    await sub.subscribe(base + "/+/telemetry", 1);
    const pub = await new Mqtt({ url: BROKER }).connect();
    await pub.publish(base + "/meter-42/telemetry", "x", 1);
    const msg = await sub.receive(5);
    assert("wildcard subscription matches", msg.topic === base + "/meter-42/telemetry");
    await sub.disconnect();
    await pub.disconnect();
  }

  // retained message to a late subscriber
  {
    const t = topic("state");
    const pub = await new Mqtt({ url: BROKER }).connect();
    await pub.publish(t, "online", 1, true);
    const late = await new Mqtt({ url: BROKER, clientId: "tina4-node-late" }).connect();
    await late.subscribe(t, 1);
    const msg = await late.receive(5);
    assert("retained delivered to late subscriber", msg.text() === "online");
    assert("retained flag set", msg.isRetained() === true);
    await pub.publish(t, "", 1, true); // clear
    await pub.disconnect();
    await late.disconnect();
  }

  // retained cleared by empty payload
  {
    const t = topic("clearme");
    const pub = await new Mqtt({ url: BROKER }).connect();
    await pub.publish(t, "value", 1, true);
    await pub.publish(t, "", 1, true); // documented reset
    const late = await new Mqtt({ url: BROKER, clientId: "tina4-node-cleared" }).connect();
    await late.subscribe(t, 1);
    await assertThrows("retained cleared by empty payload (times out)", () => late.receive(1));
    await pub.disconnect();
    await late.disconnect();
  }

  // ping round trip
  {
    const m = await new Mqtt({ url: BROKER }).connect();
    assert("ping round trip", (await m.ping(5)) === true);
    await m.disconnect();
  }

  // consume acks after the loop body
  {
    const t = topic("consume");
    const sub = await new Mqtt({ url: BROKER, clientId: "tina4-node-consume" }).connect();
    await sub.subscribe(t, 1);
    const pub = await new Mqtt({ url: BROKER }).connect();
    for (let i = 0; i < 3; i++) await pub.publish(t, `msg-${i}`, 1);
    const seen: string[] = [];
    for await (const msg of sub.consume(undefined, 1, 3, 5)) seen.push(msg.text());
    assert("consume yields all messages in order", seen.join(",") === "msg-0,msg-1,msg-2");
    await sub.disconnect();
    await pub.disconnect();
  }

  // ack-inbox: an inbound PUBLISH must not be mistaken for a PUBACK
  {
    const t = topic("selfpub");
    const c = await new Mqtt({ url: BROKER, clientId: "tina4-node-selfpub" }).connect();
    await c.subscribe(t, 1);
    const pid2 = await c.publish(t, "roundtrip", 1); // broker may push the PUBLISH before our PUBACK
    assert("self-publish does not mistake PUBLISH for PUBACK", typeof pid2 === "number");
    const msg = await c.receive(5);
    assert("self-publish message still delivered", msg.text() === "roundtrip");
    await c.disconnect();
  }

  // last will fires on ungraceful close
  {
    const willTopic = topic("will");
    const watcher = await new Mqtt({ url: BROKER, clientId: "tina4-node-watch" }).connect();
    await watcher.subscribe(willTopic, 1);
    const dying = await new Mqtt({
      url: BROKER,
      clientId: "tina4-node-dying",
      keepalive: 1,
      willTopic,
      willPayload: "device-died",
      willQos: 1,
    }).connect();
    dying.kill(); // drop the socket WITHOUT a DISCONNECT
    const msg = await watcher.receive(8); // broker fires the will past 1.5x keepalive
    assert("last will fires on ungraceful close", msg.text() === "device-died");
    await watcher.disconnect();
  }

  // write after disconnect rejects
  {
    const m = await new Mqtt({ url: BROKER }).connect();
    await m.disconnect();
    try {
      await m.publish("t", "x", 0);
      assert("write after disconnect rejects", false, "did not throw");
    } catch (e) {
      assert("write after disconnect rejects with MqttError", e instanceof MqttError);
    }
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail + 1} failed\x1b[0m`);
  process.exit(1);
});
