/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK } from "@tina4/core";
import { Database, getAdapter } from "@tina4/orm";

export const meta = { summary: "List all users", tags: ["Users"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = new Database(getAdapter());
    const users = await db.fetch("SELECT * FROM users ORDER BY id");
    return response(users, HTTP_OK);
}
