export default class User {
    static tableName = "users";
    static fields = {
        id:         { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name:       { type: "string" as const,  required: true, maxLength: 100 },
        email:      { type: "string" as const,  required: true, maxLength: 255 },
        role:       { type: "string" as const,  default: "user", maxLength: 50 },
        active:     { type: "boolean" as const, default: true },
        created_at: { type: "datetime" as const },
    };
}
