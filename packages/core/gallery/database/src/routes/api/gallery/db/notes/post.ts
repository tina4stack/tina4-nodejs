/** Gallery: Database — create a note in the gallery database. */
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response) {
  try {
    const body = (req.body as Record<string, unknown>) ?? {};
    const orm = await import("@tina4/orm");
    const db = orm.initDatabase({ type: "sqlite", path: "./data/gallery.db" });
    await db.insert("gallery_notes", {
      title: (body.title as string) ?? "Untitled",
      body: (body.body as string) ?? "",
    });
    return res.json({ created: true }, 201);
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
