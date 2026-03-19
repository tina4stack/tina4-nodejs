import type { RouteDefinition, Tina4Request, Tina4Response } from "@tina4/core";
import type { DiscoveredModel } from "./model.js";
import { getAdapter } from "./database.js";
import { buildQuery, parseQueryString } from "./query.js";
import { validate } from "./validation.js";

export function generateCrudRoutes(models: DiscoveredModel[]): RouteDefinition[] {
  const routes: RouteDefinition[] = [];

  for (const { definition } of models) {
    const { tableName, fields } = definition;
    const basePath = `/api/${tableName}`;

    // Find primary key field
    const pkField = Object.entries(fields).find(([, def]) => def.primaryKey)?.[0] ?? "id";

    // GET /api/{table} — List with filtering and pagination
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
        const { sql, countSql, params } = buildQuery(tableName, options);

        const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET
        const items = adapter.query(sql, params);
        const [{ total }] = adapter.query<{ total: number }>(countSql, countParams);

        const limit = options.limit ?? 20;
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

    // GET /api/{table}/:id — Get by ID
    routes.push({
      method: "GET",
      pattern: `${basePath}/[id]`,
      meta: {
        summary: `Get ${tableName} by ID`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();
        const items = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [req.params.id]
        );
        if (items.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }
        res.json({ data: items[0] });
      },
    });

    // POST /api/{table} — Create
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

        const columns = insertFields.map(([k]) => `"${k}"`).join(", ");
        const placeholders = insertFields.map(() => "?").join(", ");
        const values = insertFields.map(([, v]) => v);

        const result = adapter.execute(
          `INSERT INTO "${tableName}" (${columns}) VALUES (${placeholders})`,
          values
        ) as { lastInsertRowid?: number };

        const id = result.lastInsertRowid;
        const created = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [id]
        );

        res.status(201).json({ data: created[0] });
      },
    });

    // PUT /api/{table}/:id — Update
    routes.push({
      method: "PUT",
      pattern: `${basePath}/[id]`,
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

        // Check exists
        const existing = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [req.params.id]
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

        const setClause = updateFields.map(([k]) => `"${k}" = ?`).join(", ");
        const values = [...updateFields.map(([, v]) => v), req.params.id];

        adapter.execute(
          `UPDATE "${tableName}" SET ${setClause} WHERE "${pkField}" = ?`,
          values
        );

        const updated = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [req.params.id]
        );

        res.json({ data: updated[0] });
      },
    });

    // DELETE /api/{table}/:id — Delete
    routes.push({
      method: "DELETE",
      pattern: `${basePath}/[id]`,
      meta: {
        summary: `Delete ${tableName}`,
        tags: [tableName],
      },
      handler: async (req: Tina4Request, res: Tina4Response) => {
        const adapter = getAdapter();

        const existing = adapter.query(
          `SELECT * FROM "${tableName}" WHERE "${pkField}" = ?`,
          [req.params.id]
        );
        if (existing.length === 0) {
          res.status(404).json({ error: "Not Found", statusCode: 404 });
          return;
        }

        adapter.execute(
          `DELETE FROM "${tableName}" WHERE "${pkField}" = ?`,
          [req.params.id]
        );

        res.json({ message: "Deleted", data: existing[0] });
      },
    });
  }

  return routes;
}
