/** Gallery: ORM — list products (demo data). */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (_req: Tina4Request, res: Tina4Response) {
  return res.json({
    products: [
      { id: 1, name: "Widget", price: 9.99 },
      { id: 2, name: "Gadget", price: 24.99 },
    ],
    note: "Connect a database and deploy the ORM model for live data",
  });
}
