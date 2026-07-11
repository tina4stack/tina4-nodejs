import type { Tina4Request, Tina4Response, RouteDefinition } from "../../core/src/index.js";

// The UI assets load from a CDN by default (a documented architecture decision —
// we don't vendor ~1.4MB of swagger-ui-dist, to stay small). Air-gapped
// deployments point TINA4_SWAGGER_UI_CDN at a self-hosted mirror (a base URL
// serving swagger-ui.css + swagger-ui-bundle.js).
function swaggerUiCdn(): string {
  return (process.env.TINA4_SWAGGER_UI_CDN ?? "https://unpkg.com/swagger-ui-dist@5").replace(/\/+$/, "");
}

const SWAGGER_UI_HTML = (specUrl: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Tina4 API Documentation</title>
  <link rel="stylesheet" href="${swaggerUiCdn()}/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${swaggerUiCdn()}/swagger-ui-bundle.js"></script>
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
  getSpec: () => unknown
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
