export default class Todo {
    static tableName = "todo";
    static fields = {
        id:         { type: "integer" as const, primaryKey: true, autoIncrement: true },
        title:      { type: "string" as const, required: true },
        completed:  { type: "integer" as const, default: 0 },
        created_at: { type: "datetime" as const },
    };
}
