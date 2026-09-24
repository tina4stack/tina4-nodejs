/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Queue — deliberately fail the next pending message. */
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
      return res.json({ failed: false, message: "No pending messages to fail" });
    }

    db.execute(
      "UPDATE tina4_queue SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?",
      ["Deliberately failed via gallery demo", row.id]
    );

    return res.json({ failed: true, job_id: row.id, data: row.data });
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
