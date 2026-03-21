# GraphQL

Tina4 includes a zero-dependency GraphQL engine with a recursive-descent parser, schema builder, and query executor. No Apollo, no graphql-js needed.

## Basic Usage

```typescript
import { GraphQL } from "tina4-nodejs";

const gql = new GraphQL();

// Define types
gql.addType("User", {
  id:    { type: "ID" },
  name:  { type: "String" },
  email: { type: "String" },
  age:   { type: "Int" },
});

// Define queries
gql.addQuery("user", { id: "ID!" }, "User", (root, args) => {
  return { id: args.id, name: "Alice", email: "alice@test.com", age: 30 };
});

gql.addQuery("users", {}, "[User]", () => {
  return [
    { id: "1", name: "Alice", email: "alice@test.com", age: 30 },
    { id: "2", name: "Bob", email: "bob@test.com", age: 25 },
  ];
});

// Execute a query
const result = gql.execute('{ user(id: "1") { name email } }');
// { data: { user: { name: "Alice", email: "alice@test.com" } }, errors: undefined }
```

## Mutations

```typescript
gql.addMutation("createUser", { name: "String!", email: "String!" }, "User", (root, args) => {
  const newUser = { id: "3", name: args.name, email: args.email, age: null };
  // Save to database...
  return newUser;
});

const result = gql.execute(`
  mutation {
    createUser(name: "Charlie", email: "charlie@test.com") {
      id
      name
    }
  }
`);
```

## Variables

```typescript
const result = gql.execute(
  `query GetUser($userId: ID!) {
    user(id: $userId) { name email }
  }`,
  { userId: "1" },  // Variables
);
```

## Aliases

```typescript
const result = gql.execute(`
  {
    alice: user(id: "1") { name }
    bob: user(id: "2") { name }
  }
`);
// { data: { alice: { name: "Alice" }, bob: { name: "Bob" } } }
```

## Type System

| GraphQL Type | Description |
|-------------|-------------|
| `String` | Text value |
| `Int` | Integer value |
| `Float` | Floating-point value |
| `Boolean` | True/false |
| `ID` | Unique identifier |
| `[Type]` | List of Type |
| `Type!` | Non-null Type |

## As a Route Handler

```typescript
// src/routes/graphql/post.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { GraphQL } from "tina4-nodejs";

const gql = new GraphQL();
// ... register types, queries, mutations ...

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const { query, variables } = req.body as { query: string; variables?: Record<string, unknown> };
  const result = gql.execute(query, variables);
  res.json(result);
}
```

## Error Handling

Resolver exceptions are captured as GraphQL errors:

```typescript
gql.addQuery("failing", {}, "String", () => {
  throw new Error("Something went wrong");
});

const result = gql.execute("{ failing }");
// { data: { failing: null }, errors: [{ message: "Something went wrong", path: ["failing"] }] }
```

## GraphQLResult Interface

```typescript
interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: string[] }>;
}
```

## Notes

- The parser handles queries, mutations, variables, aliases, and nested selections.
- The engine is synchronous -- resolvers should return data directly (not promises).
- This is a subset implementation suitable for most API use cases.
