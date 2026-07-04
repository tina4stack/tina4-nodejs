/**
 * Frond {% live %} blocks — engine, endpoint (respondLive), push (pushLive).
 * Mirrors the Python test_frond_live* suites and PHP/Ruby FrondLive tests.
 * No mocks: real Frond, plain request-shaped values (the actual data a provider
 * consumes — respondLive is a pure {status, body} function). Parity with Python.
 * Run with: npx tsx test/frondLive.test.ts
 */
import { Frond } from "../packages/frond/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}`);
  }
}

function throws(label: string, fn: () => void): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(label, threw);
}

console.log("=== Frond {% live %} Blocks Tests ===\n");

// ── engine ────────────────────────────────────────────────────
console.log("--- engine ---");
Frond.clearRegistry();
{
  const engine = new Frond();
  const out = engine.renderString(
    '{% live "notifications" poll 5 %}<ul>{% for n in items %}<li>{{ n }}</li>{% endfor %}</ul>{% endlive %}',
    { items: ["a", "b"] },
  );
  assert("poll first paint: data-frond-live", out.includes('data-frond-live="notifications"'));
  assert("poll first paint: id", out.includes('id="live-notifications"'));
  assert("poll first paint: data-mode", out.includes('data-mode="poll"'));
  assert("poll first paint: data-interval", out.includes('data-interval="5"'));
  assert("poll first paint: data-src", out.includes('data-src="/__frond/live/notifications"'));
  assert("poll first paint: body rendered", out.includes("<li>a</li>"));
  assert("fragment registered", Frond.hasLiveFragment("notifications") === true);
}

Frond.clearRegistry();
{
  const engine = new Frond();
  engine.renderString('{% live "cart" poll 3 %}<b>{{ count }}</b>{% endlive %}', { count: 1 });
  const html = Frond.renderLive("cart", { count: 9 });
  assert("renderLive re-renders with fresh data", (html ?? "").includes("<b>9</b>"));
}

Frond.clearRegistry();
assert("renderLive unknown -> null", Frond.renderLive("never-registered", {}) === null);

Frond.clearRegistry();
{
  const out = new Frond().renderString('{% live "feed" sse %}<span>{{ n }}</span>{% endlive %}', { n: 12 });
  assert("sse mode: data-mode", out.includes('data-mode="sse"'));
  assert("sse mode: data-src", out.includes('data-src="/__frond/live/feed"'));
}

Frond.clearRegistry();
{
  const out = new Frond().renderString('{% live "chat" ws "/ws/chat" %}hi{% endlive %}', {});
  assert("ws mode: data-mode", out.includes('data-mode="ws"'));
  assert("ws mode: data-ws", out.includes('data-ws="/ws/chat"'));
  assert("ws mode: getLiveWsPath", Frond.getLiveWsPath("chat") === "/ws/chat");
}

Frond.clearRegistry();
{
  const out = new Frond().renderString('{% live "cart" poll 5 src "/fragments/cart" %}0{% endlive %}', {});
  assert("explicit src route", out.includes('data-src="/fragments/cart"'));
}

Frond.clearRegistry();
throws("unknown transport throws", () => new Frond().renderString('{% live "x" bogus %}y{% endlive %}', {}));
throws("poll without seconds throws", () => new Frond().renderString('{% live "x" poll %}y{% endlive %}', {}));
throws("cross-origin src rejected", () =>
  new Frond().renderString('{% live "x" poll 5 src "http://evil.example/x" %}y{% endlive %}', {}));
throws("nested live throws", () =>
  new Frond().renderString('{% live "a" poll 5 %}{% live "b" poll 5 %}z{% endlive %}{% endlive %}', {}));

Frond.clearRegistry();
{
  const fn = (_req: any) => ({ n: 3 });
  Frond.liveSource("orders", fn);
  assert("liveSource registers provider", Frond.getLiveSource("orders") === fn);
}

// ── endpoint (respondLive) ────────────────────────────────────
console.log("\n--- respondLive endpoint ---");
Frond.clearRegistry();
{
  const engine = new Frond();
  engine.renderString('{% live "cart" poll 5 %}<b>{{ count }}</b> items{% endlive %}', { count: 1 });
  Frond.liveSource("cart", (_r) => ({ count: 7 }));
  const r = Frond.respondLive({}, "cart");
  assert("endpoint 200 with provider data", r.status === 200);
  assert("endpoint re-renders provider data", r.body.includes("<b>7</b> items"));
}

Frond.clearRegistry();
{
  const r = Frond.respondLive({}, "nope");
  assert("endpoint unknown name -> 404", r.status === 404);
}

Frond.clearRegistry();
{
  Frond.liveSource("later", (_r) => ({ x: 1 }));
  const r = Frond.respondLive({}, "later");
  assert("endpoint fragment-not-rendered -> 404", r.status === 404);
}

Frond.clearRegistry();
{
  // IDOR guard: the provider re-runs with the live request every refresh, so an
  // unauthenticated caller never gets another user's data.
  const engine = new Frond();
  engine.renderString('{% live "me" poll 5 %}<span>{{ who }}</span>{% endlive %}', { who: "" });
  Frond.liveSource("me", (req) => ({ who: (req.headers?.["x-user"] as string) || "guest" }));

  const anon = Frond.respondLive({ headers: {} }, "me");
  assert("endpoint anon -> guest", anon.body.includes("<span>guest</span>"));

  const authed = Frond.respondLive({ headers: { "x-user": "alice" } }, "me");
  assert("endpoint authed -> alice", authed.body.includes("<span>alice</span>"));
  assert("endpoint anon never sees alice", !anon.body.includes("alice"));
}

Frond.clearRegistry();
{
  const engine = new Frond();
  engine.renderString('{% live "static" poll 5 %}<p>hello</p>{% endlive %}', {});
  const r = Frond.respondLive({}, "static");
  assert("endpoint no-provider fragment 200", r.status === 200);
  assert("endpoint no-provider fragment body", r.body.includes("<p>hello</p>"));
}

// ── pushLive ──────────────────────────────────────────────────
console.log("\n--- pushLive ---");
Frond.clearRegistry();
{
  const engine = new Frond();
  engine.renderString('{% live "score" ws "/ws/score" %}<b>{{ n }}</b>{% endlive %}', { n: 0 });
  const html = Frond.pushLive("score", { n: 5 });
  assert("pushLive returns rendered html", (html ?? "").includes("<b>5</b>"));
}

Frond.clearRegistry();
assert("pushLive unknown -> null", Frond.pushLive("ghost", {}) === null);

// ── Summary ───────────────────────────────────────────────────
Frond.clearRegistry();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
