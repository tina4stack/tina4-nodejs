import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ModelDefinition, FieldDefinition } from "./types.js";

export interface DiscoveredModel {
  definition: ModelDefinition;
  filePath: string;
}

export async function discoverModels(modelsDir: string): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let files: string[];

  try {
    files = readdirSync(modelsDir);
  } catch {
    return models;
  }

  for (const file of files) {
    const filePath = join(modelsDir, file);
    const stat = statSync(filePath);
    if (!stat.isFile()) continue;

    const ext = extname(file);
    if (ext !== ".ts" && ext !== ".js") continue;

    try {
      const moduleUrl = `file://${filePath}?t=${Date.now()}`;
      const mod = await import(moduleUrl);
      const ModelClass = mod.default ?? mod;

      if (!ModelClass.tableName || !ModelClass.fields) {
        console.warn(`  Warning: ${file} does not export a valid model (needs static tableName and fields), skipping`);
        continue;
      }

      const definition: ModelDefinition = {
        tableName: ModelClass.tableName,
        fields: ModelClass.fields as Record<string, FieldDefinition>,
      };

      models.push({ definition, filePath });
    } catch (err) {
      console.error(`  Error loading model ${file}:`, err);
    }
  }

  return models;
}
