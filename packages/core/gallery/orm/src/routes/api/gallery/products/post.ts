/** Gallery: ORM — create a product (demo). */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  const data = (req.body as Record<string, unknown>) ?? {};
  return res.json({ created: data, id: 3 }, 201);
}
