export type {
  FieldType,
  FieldDefinition,
  ModelDefinition,
  DatabaseAdapter,
  DatabaseResult as DatabaseWriteResult,
  ColumnInfo,
  QueryOptions,
  RelationshipDefinition,
  PaginatedResult,
} from "./types.js";

export { FetchResult } from "./types.js";

export { DatabaseResult } from "./databaseResult.js";
export type { ColumnInfoResult } from "./databaseResult.js";
export { Database, initDatabase, getAdapter, setAdapter, closeDatabase, parseDatabaseUrl, setNamedAdapter, getNamedAdapter, resolveDbPool, stripTrailingSemicolons } from "./database.js";
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
  migrate,
  createMigration,
  status,
  Migration,
} from "./migration.js";
export type { MigrationResult, MigrationStatus } from "./migration.js";
export { AutoCrud, generateCrudRoutes } from "./autoCrud.js";
export { buildQuery, parseQueryString } from "./query.js";
export { validate } from "./validation.js";
export type { ValidationError } from "./validation.js";
export { BaseModel, snakeToCamel, camelToSnake } from "./baseModel.js";
export { QueryBuilder } from "./queryBuilder.js";
export { SQLTranslator, QueryCache } from "./sqlTranslation.js";
export { CachedDatabaseAdapter } from "./cachedDatabase.js";
export { FakeData } from "./fakeData.js";
export { seedTable, seedOrm } from "./seeder.js";

// Database adapters
export { SQLiteAdapter } from "./adapters/sqlite.js";
export { PostgresAdapter } from "./adapters/postgres.js";
export type { PostgresConfig } from "./adapters/postgres.js";
export { MysqlAdapter } from "./adapters/mysql.js";
export type { MysqlConfig } from "./adapters/mysql.js";
export { MssqlAdapter } from "./adapters/mssql.js";
export type { MssqlConfig } from "./adapters/mssql.js";
export { FirebirdAdapter, normalizeFirebirdDbIdentifier } from "./adapters/firebird.js";
export type { FirebirdConfig } from "./adapters/firebird.js";
export { MongodbAdapter } from "./adapters/mongodb.js";
export type { MongoConfig } from "./adapters/mongodb.js";
export { OdbcAdapter } from "./adapters/odbc.js";
export type { OdbcConfig } from "./adapters/odbc.js";
