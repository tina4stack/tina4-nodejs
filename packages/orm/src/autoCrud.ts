import type { RouteDefinition, Tina4Request, Tina4Response } from "../../core/src/index.js";
import type { DiscoveredModel } from "./model.js";
import type { FieldDefinition } from "./types.js";
import { getAdapter, adapterQuery, adapterExecute } from "./database.js";
import { DatabaseResult } from "./databaseResult.js";
import { buildQuery, parseQueryString } from "./query.js";
import { validate } from "./validation.js";

/**
 * CRUD-MASS-ASSIGNMENT: filter a write body down to writable columns before
 * it is mapped to DB columns. Only DECLARED fields pass through (an unknown
 * key -- including a real-but-undeclared column like a framework-injected
 * `is_deleted` -- is dropped by construction, since it can never be `in
 * fields`); `is_deleted` is ALSO explicitly guarded for the case a model
 * chooses to declare it (soft-delete is mutated only by the DELETE handler,
 * never a POST/PUT body); and the primary key is stripped except a
 * genuinely natural (non-autoIncrement) key on CREATE, the documented way to
 * choose one (an autoIncrement CREATE has the database assign it -- a
 * client-supplied id previously passed straight into the INSERT column
 * list -- and every UPDATE strips it, because the row is addressed by the
 * URL `{id}` alone and a body PK would otherwise rename the row's own
 * identity column via the SET clause).
 */
function allowListedBody(
  fields: Record<string, FieldDefinition>,
  pkField: string,
  body: Record<string, unknown> | null | undefined,
  isCreate: boolean,
): Record<string, unknown> {
  const pkDef = fields[pkField];
  const stripPk = isCreate ? pkDef?.autoIncrement === true : true;
  const allowed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!(key in fields)) continue;
    if (key === "is_deleted") continue;
    if (stripPk && key === pkField) continue;
    allowed[key] = value;
  }
  return allowed;
}

/**
 * Auto-CRUD — discovers ORM models and auto-generates REST endpoints.
 *
 * Generated endpoints per model:
 *   GET    /api/{table}        — list with pagination, filtering, sorting
 *   GET    /api/{table}/{id}   — get single record
 *   POST   /api/{table}        — create record
 *   PUT    /api/{table}/{id}   — update record
 *   DELETE /api/{table}/{id}   — delete record
 */
/**
 * Options accepted by the AutoCrud registration API.
 *
 * `public` is the cross-backend escape hatch (parity with python's `public=True`
 * and php's `bool $public`). Write routes (POST/PUT/DELETE) are secure-by-default
 * — the router gates them unless a def sets `secure: false`. Set `public: true`
 * to open the generated write routes explicitly. Reads (GET) are always public.
 */
export interface AutoCrudOptions {
  /** When true, the generated write routes (POST/PUT/DELETE) are OPEN (secure:false). Default false → secure. */
  public?: boolean;
}

export class AutoCrud {
  private static registered: Map<string, DiscoveredModel> = new Map();
  /** tableName -> public-writes flag (default secure); mirrors php's `$this->public`. */
  private static publicWrites: Map<string, boolean> = new Map();

  /**
   * Register a model for auto-CRUD.
   *
   * @param options.public If true, the generated write routes are OPEN (no auth).
   *   Default (false) keeps them secure-by-default, matching the framework's write gate.
   */
  static register(model: DiscoveredModel, prefix: string = "/api", options: AutoCrudOptions = {}): void {
    const tableName = model.definition.tableName;
    if (!tableName) {
      throw new Error(`AutoCrud: model has no tableName set.`);
    }
    AutoCrud.registered.set(tableName, model);
    AutoCrud.publicWrites.set(tableName, options.public === true);
  }

  /**
   * Discover models from the provided array and register them.
   * (In Node.js, models are discovered by the server and passed in.)
   */
  static discover(discoveredModels: DiscoveredModel[], prefix: string = "/api", options: AutoCrudOptions = {}): string[] {
    const names: string[] = [];
    for (const model of discoveredModels) {
      AutoCrud.register(model, prefix, options);
      names.push(model.definition.tableName);
    }
    return names;
  }

  /**
   * Return all registered models.
   */
  static models(): Map<string, DiscoveredModel> {
    return new Map(AutoCrud.registered);
  }

  /**
   * Clear all registered models (useful for testing).
   */
  static clear(): void {
    AutoCrud.registered.clear();
    AutoCrud.publicWrites.clear();
  }

  /**
   * Generate route definitions for all registered models, honouring each
   * model's per-table `public` flag (set at register/discover time).
   */
  static generateRoutes(): RouteDefinition[] {
    const routes: RouteDefinition[] = [];
    for (const [tableName, model] of AutoCrud.registered) {
      const isPublic = AutoCrud.publicWrites.get(tableName) === true;
      routes.push(...generateCrudRoutes([model], { public: isPublic }));
    }
    return routes;
  }
}

/**
 * Filter discovered models down to those that explicitly opted into auto-CRUD via
 * `static autoCrud = true` (the documented opt-in gate; default false). The server
 * passes only these to generateCrudRoutes, so a model without the flag gets no CRUD
 * endpoints. Exported so the opt-in gate is locked in by a test rather than
 * re-implemented at each call site.
 */
export function crudEligibleModels(models: DiscoveredModel[]): DiscoveredModel[] {
  return models.filter(
    (m) => (m.modelClass as { autoCrud?: boolean } | undefined)?.autoCrud === true,
  );
}

/**
 * Generate CRUD route definitions for the given models.
 * (Standalone function for backward compatibility.)
 *
 * @param options.public When true, the generated write routes (POST/PUT/DELETE)
 *   opt OUT of the router's secure-by-default write gate (`secure: false`) — the
 *   cross-backend escape hatch (parity with python `public=True` / php `$public`).
 *   Default (false) leaves `secure` unset so the router gates writes (secure:true).
 *   GET routes are unaffected (reads are already public).
 */
export function generateCrudRoutes(models: DiscoveredModel[], options: AutoCrudOptions = {}): RouteDefinition[] {
  const routes: RouteDefinition[] = [];
  // Only writes are gated; `public` flips them open. Spread this into POST/PUT/
  // DELETE defs so the default path leaves `secure` unset (router → secure:true).
  const writeSecurity = options.public === true ? { secure: false as const } : {};

  for (const { definition } of models) {
    const { tableName, fields, softDelete, tableFilter, fieldMapping } = definition;
    const basePath = `/api/${tableName}`;
    const mapping = fieldMapping ?? {};

    // Helper to get DB column name for a JS property name
    const getDbCol = (prop: string): string => mapping[prop] ?? prop;

    // Find primary key field (JS property name) and its DB column name
    const pkField = Object.entries(fields).find(([, def]) => def.primaryKey)?.[0] ?? "id";
    const pkColumn = getDbCol(pkField);

    // Build extra WHERE conditions for soft delete and table filter
    const extraConditions: string[] = [];
    if (softDelete) {
      extraConditions.push(`"is_deleted" = 0`);
    }
    if (tableFilter) {
      extraConditions.push(tableFilter);
    }

    // GET /api/{table} -- List with filtering and pagination
    routes.push({
      method: "GET",
      pattern: basePath,
      meta: {
        summary: `List ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();

        // Parse query params for filtering / sorting / pagination
        const qp = parseQueryString(req.query ?? {});
        // limit/offset/page are the CLAMPED/CAPPED values buildQuery actually used
        // for the SQL (PAGE-DEC-01: page >= 1, per-page <= DEFAULT_ROW_CAP) — read
        // them back here instead of recomputing from the raw qp, so the envelope
        // can never drift from the query that ran.
        const { sql, countSql, params, limit, offset } = buildQuery(tableName, qp, extraConditions);

        // params includes limit and offset at the end; countSql doesn't need them
        const countParams = params.slice(0, -2);
        const rows = await adapterQuery(adapter, sql, params);

        // total is the TRUE total for the filter (a COUNT probe), NEVER the number
        // of rows this page returned (ADR-0043).
        const countRow = await adapterQuery(adapter, countSql, countParams);
        const total = Number(countRow[0]?.total ?? 0);

        // The REST list envelope IS the canonical paginate envelope: exactly the
        // seven snake_case keys DatabaseResult.toPaginate() builds — records, total,
        // page, per_page, total_pages, limit, offset — so this endpoint and
        // db.fetch(...).toPaginate() can never drift (ADR-0043). No `data` alias, no
        // camelCase `totalPages`, no nested `meta`.
        res.json(new DatabaseResult(rows, undefined, total, limit, offset).toPaginate());
      },
    });

    // GET /api/{table}/:id -- Get by ID
    routes.push({
      method: "GET",
      pattern: `${basePath}/{id}`,
      meta: {
        summary: `Get ${tableName} by ID`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();

        const conditions = [`"${pkColumn}" = ?`, ...extraConditions];
        const rows = await adapterQuery(adapter,
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );

        if (rows.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        res.json({ data: rows[0] });
      },
    });

    // POST /api/{table} -- Create (secure-by-default; secure:false only when public)
    routes.push({
      method: "POST",
      pattern: basePath,
      ...writeSecurity,
      meta: {
        summary: `Create ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();
        const rawBody = req.body as Record<string, unknown>;

        // CRUD-MASS-ASSIGNMENT: allow-list before anything downstream (both
        // validation and persistence) ever sees the body.
        const body = allowListedBody(fields, pkField, rawBody, true);

        // Validate against field definitions
        const errors = validate(body, fields);
        if (errors.length > 0) {
          res.status(422).json({ error: "Validation failed", errors });
          return;
        }

        // Map JS property names to DB column names
        const dbBody: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
          dbBody[getDbCol(key)] = value;
        }

        const columns = Object.keys(dbBody);
        const values = Object.values(dbBody);
        const placeholders = columns.map(() => "?").join(", ");

        // Non-SQLite engines can't read a plain INSERT's auto-id back via
        // lastInsertId(); RETURNING the PK column lets us recover it. SQLite
        // tolerates RETURNING but we still prefer its lastId below.
        const isSqlite = adapter.constructor.name === "SQLiteAdapter";
        const insertSql =
          `INSERT INTO "${tableName}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})` +
          (isSqlite ? "" : ` RETURNING "${pkColumn}"`);

        const insertResult = await adapterExecute(adapter, insertSql, values);

        // Recover the new PK: SQLite via lastInsertId(); others via RETURNING.
        let lastId: unknown = isSqlite ? adapter.lastInsertId() : null;
        if (lastId === null && insertResult && typeof insertResult === "object") {
          const rrows = (insertResult as any).rows;
          if (Array.isArray(rrows) && rrows[0]) {
            lastId = rrows[0][pkColumn] ?? rrows[0].id ?? null;
          }
        }
        if (lastId === null || lastId === undefined) {
          lastId = adapter.lastInsertId();
        }

        // Fetch the created record to include auto-generated fields (e.g. id)
        const created = await adapterQuery(adapter,
          `SELECT * FROM "${tableName}" WHERE "${pkColumn}" = ?`,
          [lastId],
        );

        res.status(201).json({ data: created[0] ?? { ...body, [pkField]: lastId } });
      },
    });

    // PUT /api/{table}/:id -- Update (secure-by-default; secure:false only when public)
    routes.push({
      method: "PUT",
      pattern: `${basePath}/{id}`,
      ...writeSecurity,
      meta: {
        summary: `Update ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();
        const rawBody = req.body as Record<string, unknown>;

        // CRUD-MASS-ASSIGNMENT: allow-list -- the row is addressed by the URL
        // {id} alone, so a body PK is stripped (never lets the write rename
        // the row's own identity column or, on a mis-wired WHERE, redirect
        // to a different row); is_deleted is guarded the same as create.
        const body = allowListedBody(fields, pkField, rawBody, false);

        // Feature 19 (VALID-NODE-PUT-NOVALIDATE): the update path validates the
        // request body too — previously only POST did, so a PUT could write
        // type/length/pattern-violating data a create would reject. isUpdate=true
        // wires the partial-update mode: an absent field is not spuriously
        // "required" (the row already has it), but a field that IS present is
        // still held to its type/length/pattern/range constraints.
        const errors = validate(body, fields, true);
        if (errors.length > 0) {
          res.status(422).json({ error: "Validation failed", errors });
          return;
        }

        const conditions = [`"${pkColumn}" = ?`, ...extraConditions];
        const existing = await adapterQuery(adapter,
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );
        if (existing.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        // Map JS property names to DB column names
        const dbBody: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(body)) {
          dbBody[getDbCol(key)] = value;
        }

        // Nothing left to write once guarded/unknown keys are stripped (e.g.
        // a body of only `{is_deleted: 1}`) -- a no-op update, not a broken
        // empty SET clause.
        if (Object.keys(dbBody).length === 0) {
          res.json({ data: existing[0] });
          return;
        }

        const setClauses = Object.keys(dbBody)
          .map((col) => `"${col}" = ?`)
          .join(", ");
        const values = [...Object.values(dbBody), req.params.id];

        await adapterExecute(adapter,
          `UPDATE "${tableName}" SET ${setClauses} WHERE "${pkColumn}" = ?`,
          values,
        );

        const updated = await adapterQuery(adapter,
          `SELECT * FROM "${tableName}" WHERE "${pkColumn}" = ?`,
          [req.params.id],
        );

        res.json({ data: updated[0] });
      },
    });

    // DELETE /api/{table}/:id -- Delete (secure-by-default; secure:false only when public)
    routes.push({
      method: "DELETE",
      pattern: `${basePath}/{id}`,
      ...writeSecurity,
      meta: {
        summary: `Delete ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();

        const conditions = [`"${pkColumn}" = ?`, ...extraConditions];
        const existing = await adapterQuery(adapter,
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );
        if (existing.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        if (softDelete) {
          await adapterExecute(adapter,
            `UPDATE "${tableName}" SET is_deleted = 1 WHERE "${pkColumn}" = ?`,
            [req.params.id],
          );
          res.json({ message: "Deleted (soft)", data: existing[0] });
        } else {
          await adapterExecute(adapter,
            `DELETE FROM "${tableName}" WHERE "${pkColumn}" = ?`,
            [req.params.id],
          );
          res.json({ message: "Deleted", data: existing[0] });
        }
      },
    });
  }

  return routes;
}
