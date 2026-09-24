/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_CREATED } from "@tina4/core";
import { getDatabase } from "@tina4/orm";

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = getDatabase();
    const { title } = request.body;
    db.execute("INSERT INTO todo (title, completed, created_at) VALUES (?, 0, datetime('now'))", [title]);
    return response({ title, completed: 0 }, HTTP_CREATED);
}
