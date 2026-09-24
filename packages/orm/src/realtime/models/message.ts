/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import { BaseModel } from "../../baseModel.js";

/**
 * Message - one posted message in a channel.
 * thread_id is null for a top-level message, or the id of the parent message
 * for a threaded reply. edited_at is null until an edit.
 */
export default class Message extends BaseModel {
  static tableName = "tina4_rt_messages";
  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    channel_id: { type: "integer" as const },
    user_id: { type: "string" as const, required: true, maxLength: 128 },
    body: { type: "text" as const },
    thread_id: { type: "integer" as const },
    created_at: { type: "datetime" as const },
    edited_at: { type: "datetime" as const },
  };
}
