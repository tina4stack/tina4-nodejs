/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import { readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { ModelDefinition, FieldDefinition, RelationshipDefinition } from "./types.js";

export interface DiscoveredModel {
  definition: ModelDefinition;
  filePath: string;
  modelClass: any;
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
        // The class name is the type name a generated OpenAPI client wants
        // (`Item`, not `items`). Carry it so Swagger keys components.schemas by
        // it. A model exported as `default` keeps its declared class name here.
        className: typeof ModelClass.name === "string" && ModelClass.name ? ModelClass.name : undefined,
        fields: ModelClass.fields as Record<string, FieldDefinition>,
        fieldMapping: ModelClass.fieldMapping as Record<string, string> | undefined,
        softDelete: ModelClass.softDelete ?? false,
        tableFilter: ModelClass.tableFilter,
        hasOne: ModelClass.hasOne as RelationshipDefinition[] | undefined,
        hasMany: ModelClass.hasMany as RelationshipDefinition[] | undefined,
        belongsTo: ModelClass.belongsTo as RelationshipDefinition[] | undefined,
        dbName: ModelClass._db,
      };

      models.push({ definition, filePath, modelClass: ModelClass });
    } catch (err) {
      console.error(`  Error loading model ${file}:`, err);
    }
  }

  return models;
}
