/** Gallery: Queue — check queue status. */
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (_req: Tina4Request, res: Tina4Response) {
  return res.json({
    topic: "gallery-tasks",
    size: 0,
    note: "Connect a queue backend for live data",
  });
}
