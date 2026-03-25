# Write Tina4 Tests

Write tests for a Tina4 feature using vitest.

## Instructions

1. Create test file in `tests/` matching the module name
2. Use vitest with TypeScript
3. Test both happy path and error cases

## Test Structure

```typescript
import { describe, it, expect } from "vitest";

describe("FeatureName", () => {
    it("should handle happy path", () => {
        const result = doSomething();
        expect(result).toBe(expected);
    });

    it("should handle edge case", () => {
        // Test boundary conditions
    });

    it("should handle errors", () => {
        expect(() => doSomethingBad()).toThrow(Error);
    });
});
```

## Testing ORM Models

```typescript
import { describe, it, expect } from "vitest";
import { Product } from "../src/orm/Product";

describe("Product", () => {
    it("should create from object", () => {
        const p = new Product({ name: "Widget", price: 9.99 });
        expect(p.name).toBe("Widget");
        expect(p.price).toBe(9.99);
    });

    it("should convert to dict", () => {
        const p = new Product({ name: "Widget", price: 9.99 });
        const d = p.toDict();
        expect(d.name).toBe("Widget");
    });

    it("should have defaults", () => {
        const p = new Product();
        expect(p.active).toBe(1);
    });
});
```

## Testing Routes (with mock request/response)

```typescript
import { describe, it, expect, vi } from "vitest";

describe("Product Routes", () => {
    it("should list products", async () => {
        const { listProducts } = await import("../src/routes/products");

        const req = { params: { page: "1", limit: "10" } };
        const responses: any[] = [];
        const res = {
            json: (data: any, code = 200) => responses.push({ data, code }),
        };

        await listProducts(req as any, res as any);
        expect(responses.length).toBe(1);
    });

    it("should create product with 201", async () => {
        const { createProduct } = await import("../src/routes/products");

        const req = { body: { name: "Test", price: 5.0 } };
        const responses: any[] = [];
        const res = {
            json: (data: any, code = 200) => responses.push({ data, code }),
        };

        await createProduct(req as any, res as any);
        expect(responses[0].code).toBe(201);
    });
});
```

## Testing Services

```typescript
import { describe, it, expect, vi } from "vitest";

describe("PaymentService", () => {
    it("should charge successfully", async () => {
        const { PaymentService } = await import("../src/app/paymentService");
        const svc = new PaymentService();

        vi.spyOn(svc.api, "post").mockResolvedValue({
            httpCode: 200,
            body: { id: "ch_1" },
            error: null,
        });

        const result = await svc.charge(1000);
        expect(result.success).toBe(true);
    });

    it("should handle charge failure", async () => {
        const { PaymentService } = await import("../src/app/paymentService");
        const svc = new PaymentService();

        vi.spyOn(svc.api, "post").mockResolvedValue({
            httpCode: 400,
            body: null,
            error: "Card declined",
        });

        const result = await svc.charge(1000);
        expect(result.success).toBe(false);
    });
});
```

## Running Tests

```bash
# All tests
npx vitest run

# Single file
npx vitest run tests/testProducts.ts

# Single test
npx vitest run tests/testProducts.ts -t "should create"

# With coverage
npx vitest run --coverage

# Watch mode
npx vitest
```

## Key Rules

- Test file names: `test<Feature>.ts`
- Use `describe()` blocks for grouping
- Test method names: `it("should <what_it_tests>")`
- Use `vi.spyOn()` and `vi.mock()` for mocking
- Mock external dependencies, not internal framework code
- Test behavior, not implementation details
- Aim for >95% coverage on new code
