# Generate Fake Data with Tina4 Seeder

Create seeders to populate tables with realistic fake data for development and testing.

## Instructions

1. Create a seeder file in `src/seeds/`
2. Use `FakeData` for realistic values
3. Run with `npx tina4 seed`

## Seeder File (`src/seeds/seedProducts.ts`)

```typescript
import { Seeder, FakeData } from "tina4-nodejs";

export class ProductSeeder extends Seeder {
    run() {
        const fake = new FakeData({ seed: 42 });  // Reproducible data

        for (let i = 0; i < 50; i++) {
            this.db.insert("products", {
                name: fake.sentence({ words: 3 }),
                price: fake.numeric({ minVal: 1.0, maxVal: 999.99, decimals: 2 }),
                category: fake.choice(["Electronics", "Books", "Clothing", "Food"]),
                active: fake.choice([0, 1]),
            });
        }
    }
}
```

## ORM-Based Seeding (Simpler)

```typescript
import { seedOrm, FakeData } from "tina4-nodejs";
import { Product } from "../orm/Product";

// Auto-generates 50 products using field types
const count = seedOrm(Product, {
    count: 50,
    overrides: {
        category: (fake: FakeData) => fake.choice(["A", "B", "C"]),
        active: 1,
    },
});
```

## Table-Based Seeding

```typescript
import { seedTable } from "tina4-nodejs";

const count = seedTable(db, "products", {
    count: 50,
    fieldMap: {
        name: "sentence",
        price: "numeric",
        category: "word",
    },
    overrides: {
        active: 1,
    },
});
```

## FakeData Reference

```typescript
import { FakeData } from "tina4-nodejs";

const fake = new FakeData({ seed: 42 });

// Text
fake.name();                                    // "Alice Johnson"
fake.email();                                   // "alice.johnson@example.com"
fake.phone();                                   // "+1-555-0142"
fake.word();                                    // "quantum"
fake.sentence({ words: 6 });                    // "The quick brown fox jumps over"
fake.paragraph({ sentences: 3 });               // Multi-sentence text

// Numbers
fake.integer({ minVal: 0, maxVal: 100 });       // 42
fake.numeric({ minVal: 0, maxVal: 1000, decimals: 2 }); // 123.45

// Dates
fake.datetime();                                // Date object
fake.date();                                    // Date object

// Utility
fake.choice(["a", "b", "c"]);                   // Random pick from array
fake.boolean();                                 // true/false
fake.uuid();                                    // UUID string

// Auto-detect from ORM field
fake.forField(StringField(), "email");           // Generates appropriate data based on column name
```

## Running Seeders

```bash
npx tina4 seed                 # Run all seeders in src/seeds/
```

## Key Rules

- Use `seed: N` for reproducible test data
- Seeder files are auto-discovered from `src/seeds/`
- Use `seedOrm()` when you have an ORM model — it auto-detects field types
- Use `seedTable()` for tables without ORM models
- Use overrides for specific values (foreign keys, statuses, etc.)
