/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: Queue — produce a message into the queue. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";
import { getQueueDb, now } from "../../../../lib/queueDb.js";

export default async function (req: Tina4Request, res: Tina4Response) {
  try {
    const body = (req.body as Record<string, unknown>) ?? {};
    const task = (body.task as string) ?? "default-task";
    const data = body.data ?? {};
    const ts = now();
    const payload = JSON.stringify({ task, data });

    const db = await getQueueDb();
    db.execute(
      "INSERT INTO tina4_queue (topic, data, status, priority, attempts, available_at, created_at) VALUES (?, ?, 'pending', 0, 0, ?, ?)",
      ["gallery-tasks", payload, ts, ts]
    );

    const row = db.fetchOne<{ last_id: number }>("SELECT last_insert_rowid() as last_id");
    const jobId = row?.last_id ?? 0;

    return res.json({ queued: true, task, job_id: jobId }, 201);
  } catch (e: unknown) {
    return res.json({ error: String(e) }, 500);
  }
}
