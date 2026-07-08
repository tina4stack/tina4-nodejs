import { BaseModel } from "../../baseModel.js";

/**
 * Workspace - the top-level container for channels (a "team" / "org").
 * Framework-owned table: the tina4_rt_ prefix keeps it clear of an app's own
 * domain tables (mirrors tina4_migration / tina4_sequences + the Python
 * master's tina4_rt_* tables). Field keys are snake_case so the columns and
 * JSON keys stay byte-identical to the master (no camelCase mapping needed).
 */
export default class Workspace extends BaseModel {
  static tableName = "tina4_rt_workspaces";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 200 },
    created_at: { type: "datetime" as const },
  };
}
