/** Gallery: REST API — simple JSON GET endpoint. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  return res.json({ message: "Hello from Tina4!", method: "GET" });
}
