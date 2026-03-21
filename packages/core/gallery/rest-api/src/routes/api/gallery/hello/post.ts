/** Gallery: REST API — simple JSON POST endpoint. */
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response) {
  const data = (req.body as Record<string, unknown>) ?? {};
  return res.json({ echo: data, method: "POST" }, 201);
}
