/**
 * v3.13.1 Ruby+Node parity tests — GraphQL.resolve decorator + Tina4Service
 * base class. Mirrors:
 *
 *   Python:   @GraphQL.resolve (3.13.0) + (Service base TBD)
 *   PHP:      GraphQL::resolve + Tina4\Service (3.13.1)
 *   Ruby:     Tina4::GraphQL.resolve + Tina4::Service (3.13.1)
 */

import { strict as assert } from "node:assert";
import { GraphQL, Tina4Service, ServiceRunner } from "@tina4/core";

let passed = 0;
let failed = 0;

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}: ${(err as Error).message}`);
    failed++;
  }
}

async function run(): Promise<void> {
  // ─── GraphQL.resolve decorator ───────────────────────────────────
  await it("GraphQL.resolve registers AND resolves a Query through the executor", async () => {
    // Don't just assert the method exists — register a resolver via the
    // public API, wire the instance as the default, and prove it both
    // registers AND resolves end-to-end through execute().
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Query", "ping", () => "pong");
    const gql = new GraphQL();
    GraphQL.setDefault(gql);
    const r = await gql.execute("{ ping }");
    assert.ok(!r.errors, `unexpected errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.data!.ping, "pong");
  });

  await it("resolve-registered Query actually runs and returns its value", async () => {
    // Don't reach into the private `queries` Map — execute the query so the
    // resolver runs and its return value flows back through the executor.
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Query", "hello", () => "world");
    const gql = new GraphQL();
    const r = await gql.execute("{ hello }");
    assert.ok(!r.errors, `unexpected errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.data!.hello, "world");
  });

  await it("resolve-registered Mutation receives args and returns the object", async () => {
    // Don't assert mutations.has(...) — execute the mutation so the resolver
    // receives its args and returns the constructed object through the executor.
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Mutation", "createWidget", (_root, args) => ({ id: 1, name: args.name }));
    const gql = new GraphQL();
    const r = await gql.execute('mutation { createWidget(name: "gizmo") { id name } }');
    assert.ok(!r.errors, `unexpected errors: ${JSON.stringify(r.errors)}`);
    const widget = r.data!.createWidget as Record<string, unknown>;
    assert.equal(widget.name, "gizmo");
    assert.equal(widget.id, 1);
  });

  await it("object-type field resolver is stashed on instance", async () => {
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Product", "reviews", async (product) => [{ id: 1, rating: 5, productId: (product as Record<string, unknown>).id }]);
    const gql = new GraphQL();
    const resolver = gql.getFieldResolver("Product", "reviews");
    assert.ok(typeof resolver === "function");
    const result = await resolver!({ id: 42 }, {}, {});
    assert.equal((result as Array<Record<string, unknown>>)[0].productId, 42);
  });

  await it("post-instantiation registration is live on the default instance", async () => {
    // A resolver registered AFTER setDefault must wire into the live schema and
    // be executable — not merely present as a key. Execute it to prove it's live.
    GraphQL._clearClassResolvers();
    const gql = new GraphQL();
    GraphQL.setDefault(gql);
    GraphQL.resolve("Query", "lateBound", () => "after init");
    const r = await gql.execute("{ lateBound }");
    assert.ok(!r.errors, `unexpected errors: ${JSON.stringify(r.errors)}`);
    assert.equal(r.data!.lateBound, "after init");
  });

  // ─── Tina4Service base class ─────────────────────────────────────
  await it("Tina4Service is a usable base class (subclass run() executes)", async () => {
    // Don't just assert the export is a function — instantiate a real subclass,
    // exercise run(), and prove the instance is a Tina4Service whose run() ran.
    class Sub extends Tina4Service {
      ran = false;
      async run(): Promise<void> {
        this.ran = true;
      }
    }
    const svc = new Sub();
    assert.ok(svc instanceof Tina4Service);
    await svc.run();
    assert.equal(svc.ran, true);
  });

  await it("subclass run loop terminates via shouldStop", async () => {
    class Worker extends Tina4Service {
      iterations = 0;
      async run(): Promise<void> {
        while (!this.shouldStop()) {
          this.iterations++;
          if (this.iterations >= 3) this.stop();
        }
      }
    }
    const svc = new Worker();
    await svc.run();
    assert.equal(svc.iterations, 3);
  });

  await it("stop() / shouldStop() flag flips correctly", () => {
    class Noop extends Tina4Service {
      async run(): Promise<void> { /* no-op */ }
    }
    const svc = new Noop();
    assert.equal(svc.shouldStop(), false);
    svc.stop();
    assert.equal(svc.shouldStop(), true);
  });

  await it("asHandler returns a handler that delegates to run()", async () => {
    // Don't just check typeof === function — invoke the handler with a real
    // ServiceContext and prove it actually delegated to the instance's run().
    class Worker extends Tina4Service {
      ran = false;
      async run(): Promise<void> {
        this.ran = true;
      }
    }
    const svc = new Worker();
    const handler = svc.asHandler();
    await handler({ running: true, lastRun: null, name: "x" });
    assert.equal(svc.ran, true);
  });

  await it("registerService wires run() as the live handler (start actually runs it)", async () => {
    // Don't just check the name appears in list() — start the service and prove
    // its run() actually executed (counter advanced) because registerService
    // wired run() as the runner's handler.
    class Worker extends Tina4Service {
      runs = 0;
      async run(): Promise<void> {
        // daemon mode runs the handler once; increment then stop ourselves so
        // shouldStop() flips and any loop would exit.
        this.runs++;
        this.stop();
      }
    }
    ServiceRunner.clear();
    const worker = new Worker();
    ServiceRunner.registerService("parity-test-service", worker);

    // Registration is observable via list()...
    const names = ServiceRunner.list().map((s) => s.name);
    assert.ok(names.includes("parity-test-service"));

    // ...but the real proof is that start() drives the wired run().
    assert.equal(worker.runs, 0, "run() must not fire before start()");
    ServiceRunner.start("parity-test-service");
    // start() schedules an async daemon execution; await a real tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(worker.runs, 1, "registerService did not wire run() as the handler");

    ServiceRunner.clear();
  });

  // eslint-disable-next-line no-console
  console.log(`\nParity tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
