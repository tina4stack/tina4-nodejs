/**
 * AMQP URL vhost contract (RabbitMQ URI spec).
 *
 * THE VHOST IS THE PATH SEGMENT, URL-DECODED, WITH NO LEADING SLASH.
 *
 * REGRESSION. All four frameworks used to prepend "/", so
 * amqp://guest:guest@rabbit:5672/orders asked the broker for a virtual host
 * literally named "/orders". No broker has that one - it is named "orders" -
 * so every publish failed against a named vhost, which is the ordinary
 * multi-tenant setup and the form every RabbitMQ tutorial shows.
 *
 * Nothing caught it because the only URL shape that worked was the one
 * carrying NO vhost, which is what every test and every dev box used - and
 * because the live-integration tests reimplemented the parser, bug included,
 * so they agreed with the framework instead of checking it.
 *
 * Pure parsing of a string: no broker, no socket, no double.
 */
import { parseAmqpUrl } from "../packages/core/src/queueBackends/rabbitmqBackend.js";

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

console.log("\nAMQP URL vhost contract\n");

// POSITIVE: the name the broker actually has.
const named = parseAmqpUrl("amqp://guest:guest@rabbit:5672/orders").vhost;
assert("vhost is the path segment", named === "orders", `got ${JSON.stringify(named)}`);
// NEGATIVE: and specifically NOT the old slash-prefixed name.
assert("vhost is not slash-prefixed", named !== "/orders", `got ${JSON.stringify(named)}`);

// The DEFAULT vhost is named "/", which cannot appear literally in a path, so
// the spec spells it "%2f". Undecoded it asks for a vhost named "%2f".
const encoded = parseAmqpUrl("amqp://rabbit:5672/%2f").vhost;
assert("percent-encoded default vhost decodes", encoded === "/", `got ${JSON.stringify(encoded)}`);
const nested = parseAmqpUrl("amqp://rabbit:5672/a%2Fb").vhost;
assert("percent-encoded slash decodes", nested === "a/b", `got ${JSON.stringify(nested)}`);
// "+" is NOT a space here: this is a path, not a form body.
const plus = parseAmqpUrl("amqp://rabbit:5672/a+b").vhost;
assert("plus is not decoded to a space", plus === "a+b", `got ${JSON.stringify(plus)}`);

// No vhost given leaves the caller's default in place.
assert("no path leaves the default", parseAmqpUrl("amqp://rabbit:5672").vhost === undefined);
assert(
  "bare trailing slash leaves the default",
  parseAmqpUrl("amqp://rabbit:5672/").vhost === undefined,
);

// The rest of the URL still parses.
const full = parseAmqpUrl("amqps://user:pass@rabbit.example.com:5671/orders");
assert("credentials still parse", full.username === "user" && full.password === "pass");
assert("host and port still parse", full.host === "rabbit.example.com" && full.port === 5671);
assert("vhost still parses alongside them", full.vhost === "orders");

console.log(`\n${"=".repeat(50)}`);
console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
console.log(`${"=".repeat(50)}\n`);

process.exit(fail > 0 ? 1 : 0);
