# Create a Tina4 SOAP/WSDL Service

Create a SOAP web service with auto-generated WSDL from TypeScript type annotations.

## Instructions

1. Create a WSDL service class in `src/app/`
2. Define operations with type annotations
3. Create a route to serve the WSDL and handle SOAP requests

## Service (`src/app/calculatorService.ts`)

```typescript
import { WSDL, wsdlOperation } from "tina4-nodejs";

class CalculatorService extends WSDL {
    constructor() {
        super({
            name: "CalculatorService",
            namespace: "http://example.com/calculator",
            url: "http://localhost:7145/soap/calculator",
        });
    }

    @wsdlOperation()
    add(a: number, b: number): number {
        return a + b;
    }

    @wsdlOperation()
    multiply(a: number, b: number): number {
        return a * b;
    }

    @wsdlOperation()
    divide(a: number, b: number): number {
        if (b === 0) {
            throw new Error("Division by zero");
        }
        return a / b;
    }
}

export const calculator = new CalculatorService();
```

## Route (`src/routes/soap.ts`)

```typescript
import { Router } from "tina4-nodejs";
import { calculator } from "../app/calculatorService";

Router.get("/soap/calculator", async (req, res) => {
    const wsdlXml = calculator.generate();
    return res.send(wsdlXml, 200, { "Content-Type": "application/xml" });
}, {
    noAuth: true,
});

Router.post("/soap/calculator", async (req, res) => {
    const result = calculator.handle(req);
    return res.send(result, 200, { "Content-Type": "application/xml" });
}, {
    noAuth: true,
});
```

## Type Mapping

| TypeScript Type | XSD Type |
|---|---|
| `string` | `xsd:string` |
| `number` (int) | `xsd:int` |
| `number` (float) | `xsd:double` |
| `boolean` | `xsd:boolean` |

## Lifecycle Hooks

```typescript
class MyService extends WSDL {
    onRequest(operation: string, params: Record<string, any>): Record<string, any> {
        // Called before operation executes — validate, log, transform input
        console.log(`Calling ${operation} with`, params);
        return params;  // Return modified params or original
    }

    onResult(operation: string, result: any): any {
        // Called after operation executes — transform output
        return result;
    }
}
```

## SOAP Client Request Example

```xml
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:calc="http://example.com/calculator">
    <soapenv:Body>
        <calc:add>
            <a>10</a>
            <b>20</b>
        </calc:add>
    </soapenv:Body>
</soapenv:Envelope>
```

## Key Rules

- Service classes go in `src/app/`, routes in `src/routes/`
- Use TypeScript type annotations — WSDL is auto-generated from them
- GET returns the WSDL definition, POST processes SOAP requests
- Use lifecycle hooks for logging, validation, and transformation
- All XML parsing uses Node.js built-in modules — zero dependencies
