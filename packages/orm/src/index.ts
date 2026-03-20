export type {
  FieldType,
  FieldDefinition,
  ModelDefinition,
  DatabaseAdapter,
  QueryOptions,
  RelationshipDefinition,
} from "./types.js";

export { initDatabase, getAdapter, setAdapter, closeDatabase, parseDatabaseUrl, setNamedAdapter, getNamedAdapter } from "./database.js";
export type { DatabaseConfig, ParsedDatabaseUrl } from "./database.js";
export { discoverModels } from "./model.js";
export type { DiscoveredModel } from "./model.js";
export {
  syncModels,
  ensureMigrationTable,
  getNextBatch,
  isMigrationApplied,
  recordMigration,
  applyMigration,
  rollback,
  getAppliedMigrations,
  getLastBatchMigrations,
  removeMigrationRecord,
} from "./migration.js";
export { generateCrudRoutes } from "./autoCrud.js";
export { buildQuery, parseQueryString } from "./query.js";
export { validate } from "./validation.js";
export type { ValidationError } from "./validation.js";
export { BaseModel } from "./baseModel.js";
