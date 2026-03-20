export type FieldType = "string" | "integer" | "number" | "boolean" | "datetime" | "text";

export interface FieldDefinition {
  type: FieldType;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  required?: boolean;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: string;
}

export interface RelationshipDefinition {
  model: string;
  foreignKey: string;
}

export interface ModelDefinition {
  tableName: string;
  fields: Record<string, FieldDefinition>;
  softDelete?: boolean;
  tableFilter?: string;
  hasOne?: RelationshipDefinition[];
  hasMany?: RelationshipDefinition[];
  dbName?: string;
}

export interface DatabaseAdapter {
  execute(sql: string, params?: unknown[]): unknown;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  close(): void;
  tableExists(name: string): boolean;
  createTable(name: string, columns: Record<string, FieldDefinition>): void;
}

export interface QueryOptions {
  filter?: Record<string, unknown>;
  sort?: string;
  page?: number;
  limit?: number;
}
