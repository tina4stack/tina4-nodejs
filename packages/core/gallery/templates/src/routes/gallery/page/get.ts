/** Gallery: Templates — render an HTML page with dynamic data via template export. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export const template = "gallery_page.twig";

export default async function (_req: Tina4Request, _res: Tina4Response) {
  return {
    title: "Gallery Demo Page",
    items: [
      { name: "Tina4 Node.js", description: "Zero-dep web framework", badge: "v3.0.0" },
      { name: "Twig Engine", description: "Built-in template rendering", badge: "included" },
      { name: "Auto-Reload", description: "Templates refresh on save", badge: "dev mode" },
    ],
  };
}
