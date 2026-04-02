import type { RouteDefinition, Tina4Request, Tina4Response } from "@tina4/core";
import type { DiscoveredModel } from "./model.js";
import { getAdapter } from "./database.js";
import { buildQuery, parseQueryString } from "./query.js";
import { validate } from "./validation.js";

export function generateCrudRoutes(models: DiscoveredModel[]): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

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
        const options = parseQueryString(req.query);
        const { sql, countSql, params } = buildQuery(tableName, options, extraConditions);

        const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET
        const items = adapter.query(sql, params);
        const [{ total }] = adapter.query<{ total: number }>(countSql, countParams);

        const limit = options.limit ?? 100;
        const page = options.page ?? 1;

        res.json({
          data: items,
          meta: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        });
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
        const items = adapter.query(
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );
        if (items.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }
        res.json({ data: items[0] });
      },
    });

    // POST /api/{table} -- Create
    routes.push({
      method: "POST",
      pattern: basePath,
      meta: {
        summary: `Create ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const body = req.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") {
          res.status(400).json({ error: "Request body is required", statusCode: 400 });
          return;
        }

        const errors = validate(body, fields, false);
        if (errors.length > 0) {
          res.status(422).json({ error: "Validation failed", statusCode: 422, errors });
          return;
        }

        const adapter = getAdapter();

        // Filter to known fields, exclude auto-increment PKs
        const insertFields = Object.entries(body).filter(([key]) => {
          const def = fields[key];
          return def && !(def.primaryKey && def.autoIncrement);
        });

        // Add is_deleted = 0 for soft delete models
        if (softDelete) {
          insertFields.push(["is_deleted", 0]);
        }

        const columns = insertFields.map(([k]) => `"${getDbCol(k)}"`).join(", ");
        const placeholders = insertFields.map(() => "?").join(", ");
        const values = insertFields.map(([, v]) => v);

        const result = adapter.execute(
          `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders})`,
          values,
        ) as { lastInsertRowid?: number };

        const id = result.lastInsertRowid;
        const created = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkColumn}" = ?`,
          [id],
        );

        res.status(201).json({ data: created[0] });
      },
    });

    // PUT /api/{table}/:id -- Update
    routes.push({
      method: "PUT",
      pattern: `${basePath}/{id}`,
      meta: {
        summary: `Update ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const body = req.body as Record<string, unknown> | undefined;
        if (!body || typeof body !== "object") {
          res.status(400).json({ error: "Request body is required", statusCode: 400 });
          return;
        }

        const errors = validate(body, fields, true);
        if (errors.length > 0) {
          res.status(422).json({ error: "Validation failed", statusCode: 422, errors });
          return;
        }

        const adapter = getAdapter();

        // Check exists (respect soft delete)
        const conditions = [`"${pkColumn}" = ?`, ...extraConditions];
        const existing = adapter.query(
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );
        if (existing.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        // Filter to known fields
        const updateFields = Object.entries(body).filter(([key]) => fields[key] && !fields[key].primaryKey);
        if (updateFields.length === 0) {
          res.json({ data: existing[0] });
          return;
        }

        const setClause = updateFields.map(([k]) => `"${getDbCol(k)}" = ?`).join(", ");
        const values = [...updateFields.map(([, v]) => v), req.params.id];

        adapter.execute(
          `UPDATE "${tableName}" SET ${setClause} WHERE "${pkColumn}" = ?`,
          values,
        );

        const updated = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkColumn}" = ?`,
          [req.params.id],
        );

        res.json({ data: updated[0] });
      },
    });

    // DELETE /api/{table}/:id -- Delete (soft or hard)
    routes.push({
      method: "DELETE",
      pattern: `${basePath}/{id}`,
      meta: {
        summary: `Delete ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();

        const conditions = [`"${pkColumn}" = ?`, ...extraConditions];
        const existing = adapter.query(
          `SELECT * FROM "${tableName}" WHERE ${conditions.join(" AND ")}`,
          [req.params.id],
        );
        if (existing.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        if (softDelete) {
          adapter.execute(
            `UPDATE "${tableName}" SET is_deleted = 1 WHERE "${pkColumn}" = ?`,
            [req.params.id],
          );
          res.json({ message: "Deleted (soft)", data: existing[0] });
        } else {
          adapter.execute(
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
