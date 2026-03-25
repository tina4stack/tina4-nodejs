# Generate Tina4 CRUD

Create a complete CRUD implementation: migration, ORM model, API routes, template page, and tests.

## Instructions

1. Ask the user for the resource name and fields
2. Create ALL of the following:
   - Migration file
   - ORM model
   - REST API routes (list, get, create, update, delete)
   - Template page with listing
   - Tests

## Example: Products CRUD

### 1. Migration (`migrations/NNNNNN_create_products.sql`)

```sql
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    category TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

### 2. ORM Model (`src/orm/Product.ts`)

```typescript
import { BaseModel, IntegerField, StringField, NumericField, DateTimeField } from "tina4-nodejs";

export class Product extends BaseModel {
    static tableName = "products";

    id = IntegerField({ primaryKey: true, autoIncrement: true });
    name = StringField();
    price = NumericField();
    category = StringField();
    active = IntegerField({ default: 1 });
    createdAt = DateTimeField();
}
```

### 3. API Routes (`src/routes/products.ts`)

```typescript
import { Router } from "tina4-nodejs";

Router.get("/api/products", async (req, res) => {
    const { Product } = await import("../orm/Product");
    const page = parseInt(req.params.page ?? "1");
    const limit = parseInt(req.params.limit ?? "20");
    const skip = (page - 1) * limit;
    const search = req.params.search ?? "";

    let results;
    if (search) {
        results = new Product().select({
            filter: "name LIKE ?", params: [`%${search}%`],
            limit, skip,
        });
    } else {
        results = new Product().select({ limit, skip });
    }

    return res.json(results.toPaginate({ page, perPage: limit }));
}, {
    description: "List products with pagination",
    tags: ["products"],
});

Router.get("/api/products/:id", async (req, res) => {
    const { Product } = await import("../orm/Product");
    const product = new Product();
    if (product.load("id = ?", [req.params.id])) {
        return res.json(product.toDict());
    }
    return res.json({ error: "Not found" }, 404);
}, {
    description: "Get a product",
    tags: ["products"],
});

Router.post("/api/products", async (req, res) => {
    const { Product } = await import("../orm/Product");
    const product = new Product(req.body);
    product.save();
    return res.json(product.toDict(), 201);
}, {
    description: "Create a product",
    tags: ["products"],
});

Router.put("/api/products/:id", async (req, res) => {
    const { Product } = await import("../orm/Product");
    const product = new Product();
    if (!product.load("id = ?", [req.params.id])) {
        return res.json({ error: "Not found" }, 404);
    }
    for (const [key, value] of Object.entries(req.body)) {
        if (key !== "id" && key in product) {
            (product as any)[key] = value;
        }
    }
    product.save();
    return res.json(product.toDict());
}, {
    description: "Update a product",
    tags: ["products"],
});

Router.delete("/api/products/:id", async (req, res) => {
    const { Product } = await import("../orm/Product");
    const product = new Product();
    if (!product.load("id = ?", [req.params.id])) {
        return res.json({ error: "Not found" }, 404);
    }
    product.delete();
    return res.json({ deleted: true });
}, {
    description: "Delete a product",
    tags: ["products"],
});
```

### 4. Template (`src/templates/pages/products.twig`)

```twig
{% extends "base.twig" %}
{% block title %}Products{% endblock %}
{% block content %}
<div class="container mt-4">
    <h1>{{ title }}</h1>
    <table class="table">
        <thead>
            <tr>
                <th>Name</th>
                <th>Price</th>
                <th>Category</th>
            </tr>
        </thead>
        <tbody>
        {% for product in products %}
            <tr>
                <td>{{ product.name }}</td>
                <td>{{ product.price }}</td>
                <td>{{ product.category }}</td>
            </tr>
        {% endfor %}
        </tbody>
    </table>
</div>
{% endblock %}
```

### 5. Tests (`tests/testProducts.ts`)

```typescript
import { describe, it, expect } from "vitest";
import { Product } from "../src/orm/Product";

describe("Product", () => {
    it("should create from object", () => {
        const p = new Product({ name: "Widget", price: 9.99, category: "Tools" });
        expect(p.name).toBe("Widget");
        expect(p.price).toBe(9.99);
    });

    it("should convert to dict", () => {
        const p = new Product({ name: "Widget", price: 9.99 });
        const d = p.toDict();
        expect(d.name).toBe("Widget");
    });

    it("should create from JSON", () => {
        const p = new Product(JSON.parse('{"name": "Gadget", "price": 19.99}'));
        expect(p.name).toBe("Gadget");
    });
});
```

### 6. Run

```bash
npx tina4 migrate
npx tina4 test
```

## After Generation

- Run `npx tina4 migrate` to create the table
- Run `npx tina4 test` to verify tests pass
- Visit `/swagger` to see the API documentation
- Use `npx tina4 routes` to list all registered routes
