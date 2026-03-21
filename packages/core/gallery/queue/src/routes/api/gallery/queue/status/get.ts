/** Gallery: Queue — list all messages with statuses. */
import type { Tina4Request, Tina4Response } from "@tina4/core";
import { getQueueDb, MAX_RETRIES } from "../../../../lib/queueDb.js";

export default async function (_req: Tina4Request, res: Tina4Response) {
  try {
    const db = await getQueueDb();

    const rows = db.fetch<Record<string, unknown>>(
      "SELECT * FROM tina4_queue WHERE topic = ? ORDER BY id DESC",
      ["gallery-tasks"],
      100
    );

    const counts: Record<string, number> = { pending: 0, reserved: 0, completed: 0, failed: 0 };
    const messages = (rows ?? []).map((row) => {
      const status = (row.status as string) ?? "pending";
      const attempts = (row.attempts as number) ?? 0;
      let displayStatus = status;
      if (status === "failed" && attempts >= MAX_RETRIES) {
        displayStatus = "dead";
      }
      if (status in counts) {
        counts[status]++;
      }
      return {
        id: row.id,
        data: row.data ?? "",
        status: displayStatus,
        attempts,
        error: row.error ?? "",
        created_at: row.created_at ?? "",
      };
    });

    return res.json({ topic: "gallery-tasks", messages, counts });
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
