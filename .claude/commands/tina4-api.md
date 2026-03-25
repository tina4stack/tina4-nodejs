# Create a Tina4 API Integration

Set up an external API client using the built-in Api class. Never use raw `fetch` or `axios`.

## Instructions

1. Create a service module in `src/app/` for the API client
2. Create route handlers that use the service
3. Use queues for slow API calls

## Service (`src/app/paymentService.ts`)

```typescript
import { Api } from "tina4-nodejs";

class PaymentService {
    private api: Api;

    constructor() {
        this.api = new Api({ baseUrl: "https://api.stripe.com/v1" });
        this.api.setBearerToken("sk_live_xxx");
    }

    async charge(amount: number, currency: string = "usd"): Promise<Record<string, any>> {
        const result = await this.api.post("/charges", { amount, currency });
        if (result.error) {
            return { success: false, error: result.error };
        }
        return { success: true, charge: result.body };
    }

    async getCustomer(customerId: string): Promise<Record<string, any>> {
        return this.api.get(`/customers/${customerId}`);
    }
}

export const payment = new PaymentService();
```

## Route (`src/routes/payments.ts`)

```typescript
import { Router } from "tina4-nodejs";
import { payment } from "../app/paymentService";

Router.post("/api/charge", async (req, res) => {
    const result = await payment.charge(
        req.body.amount,
        req.body.currency ?? "usd",
    );
    if (!result.success) {
        return res.json({ error: result.error }, 502);
    }
    return res.json(result);
}, {
    description: "Create a payment charge",
    tags: ["payments"],
});
```

## Api Class Reference

```typescript
import { Api } from "tina4-nodejs";

const api = new Api({ baseUrl: "https://api.example.com" });

// Auth options
api.setBearerToken("token123");
api.setBasicAuth("username", "password");
api.addHeaders({ "X-API-Key": "key123" });

// HTTP methods — all return { httpCode, body, headers, error }
const result = await api.get("/users");
const result = await api.post("/users", { name: "Alice" });
const result = await api.put("/users/1", { name: "Bob" });
const result = await api.patch("/users/1", { name: "Bob" });
const result = await api.delete("/users/1");

// Response is auto-parsed: JSON → object, otherwise raw text
if (result.error === null) {
    const data = result.body;       // object if JSON, string if text
    const status = result.httpCode;
}
```

## Key Rules

- Always create a service class in `src/app/` — don't put API logic in routes
- Use module-level singletons for API clients
- For slow APIs (>1s), push to a Queue and process asynchronously
- The Api class auto-handles: JSON parsing, error wrapping, auth headers, SSL
