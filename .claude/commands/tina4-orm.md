# Create a Tina4 ORM Model

Create an ORM model with its corresponding migration. Always create both together.

## Instructions

1. Ask the user for the model name and fields (or infer from context)
2. Create the migration file in `migrations/`
3. Create the ORM model in `src/orm/`
4. Run the migration with `npx tina4 migrate`

## Step 1: Migration

Create `migrations/NNNNNN_create_<table>.sql`:
```sql
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

## Step 2: ORM Model

Create `src/orm/Product.ts`:
```typescript
import { BaseModel, IntegerField, StringField, TextField, NumericField, DateTimeField } from "tina4-nodejs";

export class Product extends BaseModel {
    static tableName = "products";

    id = IntegerField({ primaryKey: true, autoIncrement: true });
    name = StringField();
    description = TextField();
    price = NumericField();
    active = IntegerField({ default: 1 });
    createdAt = DateTimeField();
}
```

## Step 3: Run Migration

```bash
npx tina4 migrate
```

## Field Types

| TypeScript Field | SQLite | PostgreSQL | MySQL |
|-----------------|--------|-----------|-------|
| `IntegerField` | INTEGER | INTEGER | INTEGER |
| `StringField` | TEXT | VARCHAR(200) | VARCHAR(200) |
| `TextField` | TEXT | TEXT | TEXT |
| `NumericField` | REAL | DOUBLE PRECISION | DOUBLE |
| `DateTimeField` | TEXT | TIMESTAMP | DATETIME |
| `BlobField` | BLOB | BYTEA | BLOB |

## ORM Usage

```typescript
import { Product } from "../orm/Product";

// Create
const product = new Product({ name: "Widget", price: 9.99 });
product.save();

// Create from JSON string
const product = new Product(JSON.parse('{"name": "Widget", "price": 9.99}'));
product.save();

// Load
const product = new Product();
if (product.load("id = ?", [1])) {
    console.log(product.name);
}

// Query
const results = new Product().select({
    filter: "price > ?", params: [5.0],
    orderBy: "name ASC", limit: 20, skip: 0,
});
for (const row of results) {
    console.log(row.name);
}

// Update
product.name = "Super Widget";
product.save();

// Delete
product.delete();

// To dict/JSON
product.toDict();
product.toJson();
```

## Key Rules

- One model per file, filename matches class name
- Always create a migration alongside the model
- Never use `BaseModel.createTable()` in production — use migrations
- Table name defaults to lowercase class name + "s" (Product -> products)
- Set custom table name: `static tableName = "my_table"`
