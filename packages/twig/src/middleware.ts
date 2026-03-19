import type { Tina4Response } from "@tina4/core";
import { renderTemplate } from "./engine.js";

export function addRenderMethod(res: Tina4Response): void {
  res.render = async function (
    template: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    try {
      const html = await renderTemplate(template, data);
      this.html(html);
    } catch (err) {
      this.statusCode = 500;
      this.json({
        error: "Template rendering failed",
        statusCode: 500,
        message: String(err),
      });
    }
  };
}
