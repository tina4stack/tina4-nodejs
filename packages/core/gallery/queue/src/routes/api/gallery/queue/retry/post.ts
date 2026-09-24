/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

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
