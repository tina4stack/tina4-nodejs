/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Database — create a note in the gallery database. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  try {
    const body = (req.body as Record<string, unknown>) ?? {};
    const orm = await import("tina4-nodejs/orm");
    const db = await orm.initDatabase({ type: "sqlite", path: "./data/gallery.db" });
    await db.insert("gallery_notes", {
      title: (body.title as string) ?? "Untitled",
      body: (body.body as string) ?? "",
    });
    return res.json({ created: true }, 201);
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
