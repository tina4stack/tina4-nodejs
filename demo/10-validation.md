# Validation

Tina4 validates request bodies against model field definitions automatically on auto-CRUD endpoints. You can also call the validation function directly in custom route handlers.

## Automatic Validation

When a POST or PUT request hits an auto-CRUD endpoint, the request body is validated against the model's `static fields` before any database operation. Invalid requests receive a 422 response.

### Example Invalid Request

```bash
curl -X POST http://localhost:7148/api/users \
  -H "Content-Type: application/json" \
  -d '{"name": "", "email": "not-an-email", "age": -5}'
```

### 422 Response

```json
{
  "error": "Validation failed",
  "statusCode": 422,
  "errors": [
    { "field": "name", "message": "is required" },
    { "field": "email", "message": "does not match required pattern" },
    { "field": "age", "message": "must be at least 0" }
  ]
}
```

## Validation Rules

Rules are derived from the field definition options:

| Option | Rule |
|--------|------|
| `required: true` | Field must be present and non-empty on create (not enforced on update) |
| `type: "string"` | Value must be a string |
| `type: "integer"` | Value must be a whole number |
| `type: "number"` | Value must be numeric |
| `type: "boolean"` | Value must be `true`, `false`, `0`, `1`, `"true"`, or `"false"` |
| `type: "datetime"` | Value must be a valid date string (parseable by `Date.parse()`) |
| `minLength: N` | String must be at least N characters |
| `maxLength: N` | String must be at most N characters |
| `min: N` | Number must be at least N |
| `max: N` | Number must be at most N |
| `pattern: "regex"` | String must match the regex pattern |

## Create vs Update

- On **create** (POST), `required` fields must be provided.
- On **update** (PUT), missing fields are skipped -- only provided fields are validated.
- Primary key fields with `autoIncrement` are always skipped.

## Manual Validation

Use the `validate` function directly in custom route handlers:

```typescript
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { validate } from "tina4-nodejs";
import type { FieldDefinition } from "tina4-nodejs";

const productFields: Record<string, FieldDefinition> = {
  name:  { type: "string", required: true, minLength: 2, maxLength: 100 },
  price: { type: "number", required: true, min: 0.01 },
  sku:   { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
};

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  const body = req.body as Record<string, unknown>;

  const errors = validate(body, productFields, false); // false = create mode
  if (errors.length > 0) {
    res.status(422).json({ error: "Validation failed", errors });
    return;
  }

  // Validation passed, proceed with business logic
  res.json({ data: body }, 201);
}
```

## ValidationError Type

```typescript
interface ValidationError {
  field: string;    // The field name that failed validation
  message: string;  // Human-readable error message
}
```

## Error Messages

| Condition | Message |
|-----------|---------|
| Required field missing | `"is required"` |
| Wrong type (string expected) | `"must be a string"` |
| Wrong type (number expected) | `"must be a number"` |
| Not an integer | `"must be an integer"` |
| Wrong type (boolean expected) | `"must be a boolean"` |
| Invalid date | `"must be a valid date/time"` |
| Too short | `"must be at least N characters"` |
| Too long | `"must be at most N characters"` |
| Too small | `"must be at least N"` |
| Too large | `"must be at most N"` |
| Pattern mismatch | `"does not match required pattern"` |

## Notes

- Numeric strings are coerced to numbers for `integer` and `number` fields before validation.
- Regex patterns are pre-compiled for performance when validating multiple records.
- Validation is synchronous and runs in-process.
