# Set Up Tina4 GraphQL Endpoint

Create a GraphQL API endpoint with schema, resolvers, and route integration.

## Instructions

1. Define your schema with types, queries, and mutations
2. Register resolvers
3. Create a route that handles GraphQL requests

## Schema & Resolvers (`src/app/graphqlSchema.ts`)

```typescript
import { GraphQL, Schema } from "tina4-nodejs";

const schema = new Schema();

// Define types
schema.addType("User", {
    id: "ID!",
    name: "String!",
    email: "String!",
    role: "String",
});

// Define queries
schema.addQuery("user", "User", { id: "ID!" });
schema.addQuery("users", "[User]", { limit: "Int", offset: "Int" });

// Define mutations
schema.addMutation("createUser", "User", { name: "String!", email: "String!" });

// Create engine and register resolvers
const gql = new GraphQL(schema);

gql.resolver("user", async (args: Record<string, any>, context: any) => {
    const { User } = await import("../orm/User");
    const user = new User();
    if (user.load("id = ?", [args.id])) {
        return user.toDict();
    }
    return null;
});

gql.resolver("users", async (args: Record<string, any>, context: any) => {
    const { User } = await import("../orm/User");
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    return new User().select({ limit, skip: offset }).toList();
});

gql.resolver("createUser", async (args: Record<string, any>, context: any) => {
    const { User } = await import("../orm/User");
    const user = new User({ name: args.name, email: args.email });
    user.save();
    return user.toDict();
});

export { gql };
```

## Route (`src/routes/graphql.ts`)

```typescript
import { Router } from "tina4-nodejs";
import { gql } from "../app/graphqlSchema";

Router.post("/graphql", async (req, res) => {
    const result = gql.executeJson(req.rawBody);
    return res.json(result);
}, {
    noAuth: true,
});
```

## Auto-Generate Schema from ORM

```typescript
import { Schema } from "tina4-nodejs";
import { Product } from "../orm/Product";

const schema = new Schema();
schema.fromOrm(Product);  // Auto-creates type, query, list query
```

## GraphQL Query Syntax Reference

```graphql
# Simple query
{ users { id name email } }

# Named query with variables
query GetUser($id: ID!) {
    user(id: $id) { id name email role }
}

# Mutation
mutation CreateUser($name: String!, $email: String!) {
    createUser(name: $name, email: $email) { id name }
}

# Aliases
{ admins: users(role: "admin") { name } guests: users(role: "guest") { name } }

# Fragments
fragment UserFields on User { id name email }
query { user(id: 1) { ...UserFields } }

# Directives
query ($showEmail: Boolean!) {
    user(id: 1) { name email @include(if: $showEmail) }
}
```

## Key Rules

- Put schema definition in `src/app/`, not in routes
- Resolvers receive `(args, context)` — use context for auth info
- Use `executeJson()` for raw JSON string input, `execute()` for parsed objects
- For protected GraphQL, remove `noAuth: true` and pass token payload as context
