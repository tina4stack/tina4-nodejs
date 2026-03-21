/** Gallery: Queue — produce a background job. */
import type { Tina4Request, Tina4Response } from "@tina4/core";

export default async function (req: Tina4Request, res: Tina4Response) {
  const body = (req.body as Record<string, unknown>) ?? {};
  const task = (body.task as string) ?? "default-task";
  const data = body.data ?? {};

  // In a real app you would use:
  //   import { Queue, Producer } from "@tina4/core";
  //   const queue = new Queue(db, "gallery-tasks");
  //   const producer = new Producer(queue);
  //   producer.produce({ task, data });

  return res.json({ queued: true, task }, 201);
}
