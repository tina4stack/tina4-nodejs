/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Queue — consume (complete) the next pending message. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { getQueueDb, now } from "../../../../lib/queueDb.js";

export default async function (_req: Tina4Request, res: Tina4Response) {
  try {
    const db = await getQueueDb();
    const ts = now();

    const row = db.fetchOne<Record<string, unknown>>(
      "SELECT * FROM tina4_queue WHERE topic = ? AND status = 'pending' AND available_at <= ? ORDER BY priority DESC, id ASC",
      ["gallery-tasks", ts]
    );

    if (!row) {
      return res.json({ consumed: false, message: "No pending messages to consume" });
    }

    db.execute(
      "UPDATE tina4_queue SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'",
      [ts, row.id]
    );

    return res.json({ consumed: true, job_id: row.id, data: row.data });
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
