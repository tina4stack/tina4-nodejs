import type { DatabaseAdapter, FieldDefinition } from "./types.js";

let activeAdapter: DatabaseAdapter | null = null;

export function setAdapter(adapter: DatabaseAdapter): void {
  activeAdapter = adapter;
}

export function getAdapter(): DatabaseAdapter {
  if (!activeAdapter) {
    throw new Error("No database adapter configured. Call setAdapter() first.");
  }
  return activeAdapter;
}

export function closeDatabase(): void {
  if (activeAdapter) {
    activeAdapter.close();
    activeAdapter = null;
  }
}

export interface DatabaseConfig {
  type?: "sqlite" | "postgres" | "mysql";
  path?: string;
  url?: string;
}

export async function initDatabase(config?: DatabaseConfig): Promise<DatabaseAdapter> {
  const type = config?.type ?? "sqlite";

  switch (type) {
    case "sqlite": {
      const { SQLiteAdapter } = await import("./adapters/sqlite.js");
      const adapter = new SQLiteAdapter(config?.path ?? "./data/tina4.db");
      setAdapter(adapter);
      return adapter;
    }
    case "postgres":
      throw new Error("PostgreSQL adapter not yet implemented. Coming soon.");
    case "mysql":
      throw new Error("MySQL adapter not yet implemented. Coming soon.");
    default:
      throw new Error(`Unknown database type: ${type}`);
  }
}
