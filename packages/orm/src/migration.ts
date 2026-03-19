import type { FieldDefinition } from "./types.js";
import type { SQLiteAdapter } from "./adapters/sqlite.js";
import type { DiscoveredModel } from "./model.js";
import { getAdapter } from "./database.js";

export function syncModels(models: DiscoveredModel[]): void {
  const adapter = getAdapter() as SQLiteAdapter;

  for (const { definition } of models) {
    const { tableName, fields } = definition;

    if (!adapter.tableExists(tableName)) {
      adapter.createTable(tableName, fields);
      console.log(`    Created table: ${tableName}`);
    } else {
      // Check for new columns
      const existing = adapter.getTableColumns(tableName);
      const existingNames = new Set(existing.map((c) => c.name));

      for (const [colName, def] of Object.entries(fields)) {
        if (!existingNames.has(colName)) {
          adapter.addColumn(tableName, colName, def);
          console.log(`    Added column: ${tableName}.${colName}`);
        }
      }
    }
  }
}
