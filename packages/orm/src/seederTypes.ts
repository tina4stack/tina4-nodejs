/** Result of a seed run. */
export interface SeedSummary {
  seeded: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

/** Options shared by the table and ORM seed paths. */
export interface SeedOptions {
  overrides?: Record<string, unknown>;
  clear?: boolean;
  seed?: number;
  strict?: boolean;
}
