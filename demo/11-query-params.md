# Query Parameters

Auto-CRUD list endpoints (`GET /api/{table}`) support filtering, sorting, and pagination via query parameters. The query builder constructs parameterized SQL from the query string.

## Filtering

Use `filter[field]=value` for exact matches and `filter[field][operator]=value` for comparisons.

### Exact Match

```bash
GET /api/users?filter[name]=Alice
GET /api/products?filter[active]=1
```

### Comparison Operators

```bash
GET /api/products?filter[price][gt]=10
GET /api/products?filter[price][lte]=100
GET /api/users?filter[age][gte]=18&filter[age][lt]=65
GET /api/products?filter[name][like]=%widget%
GET /api/users?filter[status][ne]=banned
```

| Operator | SQL | Description |
|----------|-----|-------------|
| `gt` | `>` | Greater than |
| `gte` | `>=` | Greater than or equal |
| `lt` | `<` | Less than |
| `lte` | `<=` | Less than or equal |
| `ne` | `!=` | Not equal |
| `like` | `LIKE` | SQL LIKE pattern (use `%` for wildcards) |

### Combining Filters

Multiple filters are combined with AND:

```bash
GET /api/products?filter[price][gte]=10&filter[price][lte]=50&filter[active]=1
```

Generates: `WHERE "price" >= ? AND "price" <= ? AND "active" = ?`

## Sorting

Use `sort=field` for ascending or `sort=-field` for descending. Multiple sort fields are comma-separated.

```bash
GET /api/users?sort=name              # Sort by name ASC
GET /api/users?sort=-createdAt        # Sort by createdAt DESC
GET /api/users?sort=-age,name         # Sort by age DESC, then name ASC
```

## Pagination

Use `page` and `limit` parameters. Defaults are `page=1` and `limit=20`.

```bash
GET /api/users?page=2&limit=10
```

### Response Format

Paginated responses include metadata:

```json
{
  "data": [
    { "id": 11, "name": "Alice" },
    { "id": 12, "name": "Bob" }
  ],
  "meta": {
    "total": 150,
    "page": 2,
    "limit": 10,
    "totalPages": 15
  }
}
```

## Combined Example

```bash
GET /api/products?filter[price][gte]=10&filter[active]=1&sort=-price&page=1&limit=5
```

This returns the first 5 active products priced at $10 or more, sorted by price descending.

## Programmatic Use

The query builder can be used directly:

```typescript
import { buildQuery, parseQueryString } from "@tina4/orm";

// Parse URL query parameters into QueryOptions
const options = parseQueryString({
  "filter[price][gte]": "10",
  "filter[active]": "1",
  "sort": "-price",
  "page": "2",
  "limit": "10",
});
// { filter: { price: { gte: "10" }, active: "1" }, sort: "-price", page: 2, limit: 10 }

// Build parameterized SQL
const { sql, countSql, params } = buildQuery("products", options);
// sql: SELECT * FROM "products" WHERE "price" >= ? AND "active" = ? ORDER BY "price" DESC LIMIT ? OFFSET ?
// params: ["10", "1", 10, 10]
```

## QueryOptions Interface

```typescript
interface QueryOptions {
  filter?: Record<string, unknown>;  // Field filters
  sort?: string;                      // Sort expression
  page?: number;                      // Page number (1-based)
  limit?: number;                     // Items per page (default: 20)
}
```
