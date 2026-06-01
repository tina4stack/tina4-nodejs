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
  await it("GraphQL.resolve static method exists", () => {
    assert.equal(typeof GraphQL.resolve, "function");
  });

  await it("resolve registers Query in class registry", () => {
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Query", "hello", async () => "world");
    const gql = new GraphQL();
    // Access via reflection — queries Map is private
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = (gql as any).queries as Map<string, unknown>;
    assert.ok(queries.has("hello"));
  });

  await it("resolve registers Mutation", () => {
    GraphQL._clearClassResolvers();
    GraphQL.resolve("Mutation", "createWidget", async (_root, args) => ({ id: 1, name: args.name }));
    const gql = new GraphQL();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mutations = (gql as any).mutations as Map<string, unknown>;
    assert.ok(mutations.has("createWidget"));
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

  await it("post-instantiation registration wires into default", () => {
    GraphQL._clearClassResolvers();
    const gql = new GraphQL();
    GraphQL.setDefault(gql);
    GraphQL.resolve("Query", "lateBound", async () => "after init");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queries = (gql as any).queries as Map<string, unknown>;
    assert.ok(queries.has("lateBound"));
  });

  // ─── Tina4Service base class ─────────────────────────────────────
  await it("Tina4Service class is exported", () => {
    assert.equal(typeof Tina4Service, "function");
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

  await it("asHandler returns a ServiceHandler callable", () => {
    class Noop extends Tina4Service {
      async run(): Promise<void> { /* no-op */ }
    }
    const svc = new Noop();
    const handler = svc.asHandler();
    assert.equal(typeof handler, "function");
  });

  await it("ServiceRunner.registerService accepts a Tina4Service", () => {
    class Worker extends Tina4Service {
      async run(): Promise<void> { /* no-op */ }
    }
    ServiceRunner.registerService("parity-test-service", new Worker());
    // Look up via static list()
    const services = ServiceRunner.list();
    const names = services.map((s) => s.name);
    assert.ok(names.includes("parity-test-service"));
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
