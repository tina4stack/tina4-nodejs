import type { Tina4Request, Tina4Response, RouteDefinition } from "../../core/src/index.js";

// The UI assets load from a CDN by default (a documented architecture decision —
// we don't vendor ~1.4MB of swagger-ui-dist, to stay small). jsdelivr
// (SWAG-CDN-NO-SRI, ADR-0004) — the SAME default as the Python and Ruby
// masters, so all four frameworks pull the UI bundle from one CDN rather than
// splitting jsdelivr/unpkg. Air-gapped deployments point TINA4_SWAGGER_UI_CDN
// at a self-hosted mirror (a base URL serving swagger-ui.css + swagger-ui-bundle.js).
function swaggerUiCdn(): string {
  return (process.env.TINA4_SWAGGER_UI_CDN ?? "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5").replace(/\/+$/, "");
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
  const serveUi = async (_req: Tina4Request, res: Tina4Response): Promise<void> => {
    res.html(SWAGGER_UI_HTML("/swagger/openapi.json"));
  };

  return [
    {
      method: "GET",
      pattern: "/swagger",
      handler: serveUi,
    },
    {
      // The trailing-slash form, registered rather than left to fall through.
      //
      // Matching "/foo/" against a "/foo" route is opt-in via
      // TINA4_TRAILING_SLASH_REDIRECT and OFF by default, so /swagger/ missed
      // this route and was answered by the framework-bundled
      // public/swagger/index.html instead. That mattered twice over. It used to
      // be a 200 carrying a permanently empty UI, because the bundled file asked
      // for an unsubstituted {SWAGGER_ROUTE}/swagger.json -- fixed in that file.
      // And it is a SECOND Swagger UI implementation: the bundled one hardcodes
      // cdnjs, while the page this handler renders loads from
      // TINA4_SWAGGER_UI_CDN, so an air-gapped deployment pointing that at a
      // local mirror silently kept reaching cdnjs on this one path.
      //
      // Registering it keeps the fix inside swagger rather than changing how
      // every route treats trailing slashes, satisfies the shared contract that
      // already requires a 200 here, and matches python and ruby, which both
      // serve /swagger and /swagger/ with no env var set. Excluded from the
      // generated document by INTERNAL_PREFIXES like /swagger itself.
      method: "GET",
      pattern: "/swagger/",
      handler: serveUi,
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
