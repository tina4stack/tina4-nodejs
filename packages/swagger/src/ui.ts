import type { Tina4Request, Tina4Response, RouteDefinition } from "@tina4/core";

const SWAGGER_UI_HTML = (specUrl: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tina4 API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: "${specUrl}",
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
    });
  </script>
</body>
</html>`;

/**
 * Whether the Swagger UI + spec routes should be registered at boot.
 *
 * Default: enabled when `TINA4_DEBUG=true`, disabled otherwise. Operators
 * can force either state with `TINA4_SWAGGER_ENABLED=true|false`. Matches
 * Python parity: dev-only by default to keep production attack surface
 * minimal, but easy to expose intentionally for public APIs.
 */
export function swaggerEnabled(): boolean {
  const raw = (process.env.TINA4_SWAGGER_ENABLED ?? "").trim().toLowerCase();
  if (raw === "") {
    const debug = (process.env.TINA4_DEBUG ?? "").trim().toLowerCase();
    return ["true", "1", "yes", "on"].includes(debug);
  }
  return ["true", "1", "yes", "on"].includes(raw);
}

export function createSwaggerRoutes(
  getSpec: () => Record<string, unknown>
): RouteDefinition[] {
  return [
    {
      method: "GET",
      pattern: "/swagger",
      handler: async (_req: Tina4Request, res: Tina4Response) => {
        res.html(SWAGGER_UI_HTML("/swagger/openapi.json"));
      },
    },
    {
      method: "GET",
      pattern: "/swagger/openapi.json",
      handler: async (_req: Tina4Request, res: Tina4Response) => {
        res.json(getSpec());
      },
    },
  ];
}
