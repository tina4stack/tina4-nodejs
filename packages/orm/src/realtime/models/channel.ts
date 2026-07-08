import { BaseModel } from "../../baseModel.js";

/**
 * Channel - a conversation stream inside a workspace.
 * kind is one of public | private | dm. workspace_id is a plain integer FK
 * column (the realtime handlers query it directly).
 */
export default class Channel extends BaseModel {
  static tableName = "tina4_rt_channels";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    workspace_id: { type: "integer" as const },
    name: { type: "string" as const, required: true, maxLength: 200 },
    kind: { type: "string" as const, default: "public", maxLength: 20 },
    created_at: { type: "datetime" as const },
  };
}
