export default class Example {
  static tableName = "examples";

  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 255 },
    description: { type: "text" as const },
    active: { type: "boolean" as const, default: true },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
