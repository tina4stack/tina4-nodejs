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
export { Database, initDatabase, getAdapter, setAdapter, bindDatabase, createAdapterFromUrl, closeDatabase, parseDatabaseUrl, setNamedAdapter, getNamedAdapter, resolveDbPool, stripTrailingSemicolons, wrapWithCache, resetRequestCaches } from "./database.js";
export {
  adapterFetch, adapterQuery, adapterFetchOne, adapterExecute,
  adapterStartTransaction, adapterCommit, adapterRollback,
  adapterTableExists, adapterTables, adapterColumns, adapterCreateTable,
  extractLastInsertId,
} from "./database.js";
export type { DatabaseConfig } from "./database.js";
export { DatabaseUrl } from "./databaseUrl.js";
export type { DatabaseEngine } from "./databaseUrl.js";
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
  splitStatements,
  parseSetTerm,
  normalizeQuotes,
  sortMigrationFiles,
  shouldSkipCreateTable,
} from "./migration.js";
export type { MigrationResult, MigrationStatus } from "./migration.js";
export { AutoCrud, generateCrudRoutes, crudEligibleModels } from "./autoCrud.js";
export type { AutoCrudOptions } from "./autoCrud.js";
export { buildQuery, parseQueryString } from "./query.js";
export { validate } from "./validation.js";
export type { ValidationError } from "./validation.js";
export { BaseModel, snakeToCamel, camelToSnake } from "./baseModel.js";
export { QueryBuilder } from "./queryBuilder.js";
export { SQLTranslator, QueryCache } from "./sqlTranslator.js";
export { CachedDatabaseAdapter } from "./cachedDatabase.js";
export type { CachedAdapterOptions } from "./cachedDatabase.js";
export { FakeData } from "./fakeData.js";
export { seedTable, seedOrm, seedModels, autoFieldMap } from "./seeder.js";
export type { SeedSummary, SeedOptions } from "./seeder.js";

// DocStore — pymongo-style document store with a zero-config SQLite (JSON1) fallback
export {
  ObjectId, InvalidId, SqliteDatabase, SqliteCollection, Cursor,
  getCollection, isServerless, resetDefaultStore,
  encodeValue, decodeValue, compileFilter,
} from "./docstore.js";
export type {
  InsertOneResult, InsertManyResult, UpdateResult, DeleteResult,
} from "./docstore.js";

// Database adapters
export { SQLiteAdapter } from "./adapters/sqlite.js";
export { PostgresAdapter } from "./adapters/postgres.js";
export type { PostgresConfig } from "./adapters/postgres.js";
export { MysqlAdapter } from "./adapters/mysql.js";
export type { MysqlConfig } from "./adapters/mysql.js";
export { MssqlAdapter } from "./adapters/mssql.js";
export type { MssqlConfig } from "./adapters/mssql.js";
export { FirebirdAdapter, normalizeFirebirdDbIdentifier, resolveFirebirdCharset } from "./adapters/firebird.js";
export type { FirebirdConfig } from "./adapters/firebird.js";
export { MongodbAdapter } from "./adapters/mongodb.js";
export type { MongoConfig } from "./adapters/mongodb.js";
export { OdbcAdapter } from "./adapters/odbc.js";
export type { OdbcConfig } from "./adapters/odbc.js";

// Realtime collaboration mount (calls + chat + files) — parity with the Python master.
export {
  realtime,
  iceServers,
  type RealtimeOptions,
  LocalStorage,
  S3Storage,
  selectStorage,
  storageKey,
  type StorageBackend,
  Workspace as RealtimeWorkspace,
  Channel as RealtimeChannel,
  ChannelMember as RealtimeChannelMember,
  Message as RealtimeMessage,
  Attachment as RealtimeAttachment,
} from "./realtime/index.js";
