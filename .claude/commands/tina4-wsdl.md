# Create a Tina4 SOAP/WSDL Service

Create a SOAP 1.1 web service with an auto-generated WSDL 1.1 definition.

## Instructions

1. Create a service class that extends `WSDLService` in `src/app/`
2. Mark each operation with `@WSDLOperation({ input, output })`
3. Add a GET route that serves the WSDL and a POST route that handles SOAP requests

## Service (`src/app/calculatorService.ts`)

```typescript
import { WSDLService, WSDLOperation } from "tina4-nodejs";

export class CalculatorService extends WSDLService {
    serviceName = "Calculator";
    serviceUrl = "/soap/calculator";

    @WSDLOperation({ input: { a: "int", b: "int" }, output: { Result: "int" } })
    async Add(a: number, b: number): Promise<Record<string, unknown>> {
        return { Result: a + b };
    }

    @WSDLOperation({ input: { text: "string" }, output: { Result: "string" } })
    async Echo(text: string): Promise<Record<string, unknown>> {
        return { Result: text };
    }
}

export const calculator = new CalculatorService();
```

`input` lists the parameters in the order the method takes them; each value is read from the
child element of the same name and converted to its type. An operation returns an object; each key
becomes an element of `<OperationResponse>`.

## Routes (`src/routes/soap.ts`)

```typescript
import { get, post } from "tina4-nodejs";
import { calculator } from "../app/calculatorService";

get("/soap/calculator", async (request, response) => {
    return response.xml(calculator.generateWSDL(`http://${request.headers.host}/soap/calculator`));
}).noAuth();

post("/soap/calculator", async (request, response) => {
    return response.xml(await calculator.handle(request.body as string));
}).noAuth();
```

## Type Mapping

| `input` / `output` type | XSD Type |
|---|---|
| `string` | `xsd:string` |
| `int`, `integer` | `xsd:int` |
| `float` | `xsd:float` |
| `double`, `number`, `numeric` | `xsd:double` |
| `bool`, `boolean` | `xsd:boolean` |

## Lifecycle Hooks

```typescript
class MyService extends WSDLService {
    serviceName = "My";
    serviceUrl = "/soap/my";

    protected onRequest(soapXml: unknown): void {
        // Called before the operation runs - validate or log
    }

    protected onResult(result: Record<string, unknown>): Record<string, unknown> {
        // Called after the operation returns - transform the result
        return result;
    }
}
```

## SOAP Client Request Example

```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:calc="urn:Calculator">
    <soap:Body>
        <calc:Add>
            <calc:a>10</calc:a>
            <calc:b>20</calc:b>
        </calc:Add>
    </soap:Body>
</soap:Envelope>
```

## Faults

Every framework answers the same bad requests with the same `Client` fault: `Malformed XML`
(not well-formed, not UTF-8, a byte-order mark, or a UTF-16 body), `DOCTYPE declarations are not
allowed in SOAP messages`, `Missing SOAP Body`, `Empty SOAP Body`, `Unknown operation: <name>`.
An exception inside an operation is a `Server` fault; its detail reaches the client only when
`TINA4_DEBUG=true`.

## Key Rules

- Service classes go in `src/app/`, routes in `src/routes/`
- GET returns the WSDL definition, POST processes SOAP requests
- Entities, character references and CDATA in parameters are decoded for you
- XML parsing is built in (no dependencies); a DOCTYPE is always refused, so there is no
  entity expansion or external entity to worry about
