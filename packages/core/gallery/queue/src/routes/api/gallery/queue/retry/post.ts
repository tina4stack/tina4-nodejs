/** Gallery: Queue — retry failed messages (re-queue under max retries). */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { getQueueDb, now, MAX_RETRIES } from "../../../../lib/queueDb.js";

export default async function (_req: Tina4Request, res: Tina4Response) {
  try {
    const db = await getQueueDb();
    const ts = now();

    db.execute(
      "UPDATE tina4_queue SET status = 'pending', available_at = ? WHERE topic = ? AND status = 'failed' AND attempts < ?",
      [ts, "gallery-tasks", MAX_RETRIES]
    );

    const row = db.fetchOne<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM tina4_queue WHERE topic = ? AND status = 'pending'",
      ["gallery-tasks"]
    );
    const retried = row?.cnt ?? 0;

    return res.json({ retried });
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
