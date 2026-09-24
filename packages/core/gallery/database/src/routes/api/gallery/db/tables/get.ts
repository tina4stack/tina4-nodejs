/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Database — list tables in the gallery database. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (_req: Tina4Request, res: Tina4Response) {
  try {
    const orm = await import("tina4-nodejs/orm");
    const db = await orm.initDatabase({ type: "sqlite", path: "./data/gallery.db" });

    await db.execute(`
      CREATE TABLE IF NOT EXISTS gallery_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const tables = await db.getTables();
    return res.json({ tables, engine: "sqlite" });
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
