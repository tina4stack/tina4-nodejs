import Twig from "twig";
import { resolve } from "node:path";

let templatesDir = "src/templates";

export function setTemplatesDir(dir: string): void {
  templatesDir = resolve(dir);
}

export function getTemplatesDir(): string {
  return templatesDir;
}

export function renderTemplate(
  templatePath: string,
  data?: Record<string, unknown>
): Promise<string> {
  const fullPath = resolve(templatesDir, templatePath);

  return new Promise((resolve, reject) => {
    Twig.renderFile(fullPath, data ?? {}, (err: Error | null, html: string) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}
