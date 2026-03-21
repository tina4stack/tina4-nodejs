/** Gallery: Database — list notes from the gallery database. */
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (_req: Tina4Request, res: Tina4Response) {
  try {
    const orm = await import("@tina4/orm");
    const db = orm.initDatabase({ type: "sqlite", path: "./data/gallery.db" });
    const result = await db.fetch("SELECT * FROM gallery_notes ORDER BY id DESC", undefined, 50);
    return res.json(result.records ?? []);
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
