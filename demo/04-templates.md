# Templates

Tina4 uses Twig as its template engine. Templates live in `src/templates/` and are rendered using `res.render()` in route handlers.

## Setup

The Twig template engine is built into `tina4-nodejs`. The `res.render()` method is automatically available on the response object. The templates directory defaults to `src/templates/`.

## Writing a Template

Templates use the Twig syntax with `.html.twig` extension.

```twig
{# src/templates/welcome.html.twig #}
<!DOCTYPE html>
<html>
<head>
  <title>{{ title }}</title>
</head>
<body>
  <h1>Welcome, {{ name }}!</h1>

  {% if items %}
  <ul>
    {% for item in items %}
      <li>{{ item.name }} - ${{ item.price }}</li>
    {% endfor %}
  </ul>
  {% else %}
    <p>No items found.</p>
  {% endif %}
</body>
</html>
```

## Rendering in a Route Handler

```typescript
// src/routes/welcome/get.ts
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.render!("welcome.html.twig", {
    title: "My Shop",
    name: "Alice",
    items: [
      { name: "Widget", price: 9.99 },
      { name: "Gadget", price: 24.50 },
    ],
  });
}
```

## Direct Template Rendering

You can also render templates programmatically without the response helper:

```typescript
import { renderTemplate, setTemplatesDir } from "tina4-nodejs";

// Override the templates directory
setTemplatesDir("src/templates");

// Render to a string
const html = await renderTemplate("email.html.twig", {
  subject: "Welcome",
  body: "Thanks for signing up!",
});
```

## Configuration

The templates directory can be configured when starting the server:

```typescript
import { startServer } from "tina4-nodejs";

await startServer({
  port: 7148,
  templatesDir: "src/views",  // Override default "src/templates"
});
```

## Error Handling

If template rendering fails (missing file, syntax error), Tina4 returns a 500 JSON response with the error message in development mode.

## Notes

- The Twig npm package is used under the hood -- full Twig syntax is supported.
- Templates are resolved relative to the configured templates directory.
- The `res.render()` method is built into the `tina4-nodejs` framework.
