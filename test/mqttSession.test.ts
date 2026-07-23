/**
 * MQTT sessions and resilience — real broker, no mocks.
 *
 * Mirrors tina4_python tests/test_mqtt_session.py, tina4-ruby
 * spec/mqtt_session_spec.rb, and tina4-php tests/MqttSessionTest.php. Drives a
 * real Mosquitto on 1883: the offline replay a durable session provides, and the
 * awkward ordering (queued QoS 1 messages arriving BEFORE the SUBACK on a
 * cleanSession=false resume) that is exactly why the ack-wait inbox has to cover
 * SUBSCRIBE and not just PUBLISH.
 *
 * Run with: npx tsx test/mqttSession.test.ts
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { Mqtt } from "../packages/core/src/mqtt.ts";

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

function brokerUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: 1883 });
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

async function main(): Promise<void> {
  if (!(await brokerUp())) {
    console.log("  \x1b[33mSKIP\x1b[0m MQTT session tests (no MQTT broker on 127.0.0.1:1883)");
    console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
    process.exit(0);
  }

  // Durable session replays QoS 1 messages published while offline, in order.
  {
    const run = randomBytes(4).toString("hex");
    const topic = `tina4/nodetest/session/${run}/offline`;
    const durableId = `tina4-node-durable-${run}`;

    const first = await new Mqtt({ url: BROKER, clientId: durableId, cleanSession: false }).connect();
    await first.subscribe(topic, 1);
    await first.disconnect();

    const pub = await new Mqtt({ url: BROKER, clientId: `tina4-node-pub-${run}` }).connect();
    for (let i = 0; i < 3; i++) await pub.publish(topic, `{"n":${i}}`, 1);
    await pub.disconnect();

    const resumed = await new Mqtt({ url: BROKER, clientId: durableId, cleanSession: false }).connect();
    const replayed: string[] = [];
    for (let i = 0; i < 3; i++) replayed.push((await resumed.receive(5)).text());
    assert("durable session replays offline QoS 1 messages in order", replayed.join(",") === '{"n":0},{"n":1},{"n":2}');
    await resumed.disconnect();
  }

  // Replayed PUBLISHes stay out of the SUBACK wait.
  {
    const run = randomBytes(4).toString("hex");
    const topic = `tina4/nodetest/session/${run}/replay-suback`;
    const durableId = `tina4-node-replay-${run}`;

    const first = await new Mqtt({ url: BROKER, clientId: durableId, cleanSession: false }).connect();
    await first.subscribe(topic, 1);
    await first.disconnect();

    const pub = await new Mqtt({ url: BROKER, clientId: `tina4-node-replay-pub-${run}` }).connect();
    for (let i = 0; i < 3; i++) await pub.publish(topic, `queued-${i}`, 1);
    await pub.disconnect();

    // Resume and immediately issue ANOTHER subscribe: its SUBACK now competes
    // with the replayed PUBLISHes already streaming in.
    const resumed = await new Mqtt({ url: BROKER, clientId: durableId, cleanSession: false }).connect();
    assert("subscribe survives an interleaved replayed PUBLISH", (await resumed.subscribe(topic, 1)) === 1);
    const replayed: string[] = [];
    for (let i = 0; i < 3; i++) replayed.push((await resumed.receive(5)).text());
    assert("replayed PUBLISHes are delivered, not mistaken for the SUBACK", replayed.join(",") === "queued-0,queued-1,queued-2");
    await resumed.disconnect();
  }

  // cleanSession=true does NOT replay.
  {
    const run = randomBytes(4).toString("hex");
    const topic = `tina4/nodetest/session/${run}/clean`;
    const cleanId = `tina4-node-clean-${run}`;

    const first = await new Mqtt({ url: BROKER, clientId: cleanId, cleanSession: true }).connect();
    await first.subscribe(topic, 1);
    await first.disconnect(); // cleanSession=true -> broker throws the subscription away

    const pub = await new Mqtt({ url: BROKER, clientId: `tina4-node-clean-pub-${run}` }).connect();
    await pub.publish(topic, "lost", 1);
    await pub.disconnect();

    const resumed = await new Mqtt({ url: BROKER, clientId: cleanId, cleanSession: true }).connect();
    await resumed.subscribe(topic, 1);
    let timedOut = false;
    try {
      await resumed.receive(1); // nothing was queued -> times out
    } catch {
      timedOut = true;
    }
    assert("cleanSession=true does not replay (times out)", timedOut);
    await resumed.disconnect();
  }

  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.log(`\n  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail + 1} failed\x1b[0m`);
  process.exit(1);
});
