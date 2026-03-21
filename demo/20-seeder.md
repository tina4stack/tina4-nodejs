# Seeder

Tina4 includes a `Seeder` class for generating fake data during development and testing. All methods are static and use Node.js built-in `crypto` for randomness. Zero dependencies.

## Generating Fake Data

```typescript
import { Seeder } from "tina4-nodejs";

// Names
Seeder.firstName();       // "Alice"
Seeder.lastName();        // "Johnson"
Seeder.fullName();        // "Bob Williams"

// Contact
Seeder.email();           // "charlie42@example.com"
Seeder.phone();           // "+1-555-847-2390"

// Text
Seeder.word();            // "lorem"
Seeder.sentence();        // "The quick brown fox jumps over."
Seeder.paragraph();       // Multiple sentences...

// Numbers
Seeder.integer(1, 100);   // 42
Seeder.float(0, 1);       // 0.7382

// Dates
Seeder.date();            // "2024-03-15"
Seeder.datetime();        // "2024-03-15T14:30:00.000Z"
Seeder.pastDate();        // Date in the past
Seeder.futureDate();      // Date in the future

// Location
Seeder.city();            // "Tokyo"
Seeder.country();         // "Germany"
Seeder.address();         // "42 Main St"

// Identifiers
Seeder.uuid();            // "a1b2c3d4-e5f6-..."
Seeder.boolean();         // true or false

// Pick from array
Seeder.pick(["red", "green", "blue"]);  // "green"
```

## Seeding a Database

```typescript
import { Seeder } from "tina4-nodejs";
import { getAdapter } from "tina4-nodejs";

const db = getAdapter();

// Seed 50 users
for (let i = 0; i < 50; i++) {
  db.execute(
    'INSERT INTO users (name, email, age, active) VALUES (?, ?, ?, ?)',
    [
      Seeder.fullName(),
      Seeder.email(),
      Seeder.integer(18, 80),
      Seeder.boolean() ? 1 : 0,
    ],
  );
}

console.log("Seeded 50 users");
```

## Seed from JSON Files

The `Seeder` can also load seed data from JSON files:

```typescript
import { Seeder } from "tina4-nodejs";

// Load and process seed files from a directory
// Place JSON files in a seeds/ directory with table name as filename
// e.g., seeds/users.json, seeds/products.json
```

## In a Route Handler (Dev Only)

```typescript
// src/routes/api/seed/post.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { Seeder } from "tina4-nodejs";
import { getAdapter } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ error: "Seeding disabled in production" });
    return;
  }

  const db = getAdapter();
  const count = Number(req.query.count) || 10;

  for (let i = 0; i < count; i++) {
    db.execute(
      'INSERT INTO products (name, price, active) VALUES (?, ?, ?)',
      [
        `${Seeder.word()} ${Seeder.word()}`,
        Seeder.float(1, 999),
        1,
      ],
    );
  }

  res.json({ message: `Seeded ${count} products` });
}
```

## Available Data Banks

The seeder includes built-in word banks for:
- 52 first names
- 50 last names
- 5 email domains
- 40+ common words (for sentences/paragraphs)
- 25 cities
- 20 countries
- 15 street names

## Notes

- All randomness comes from `crypto.randomInt()` and `crypto.randomUUID()`.
- The seeder is designed for development/testing. Guard seed endpoints in production.
- Methods are stateless and can be called concurrently.
