/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import type { Tina4Request, Tina4Response } from "@tina4/core";
import { HTTP_OK, HTTP_NOT_FOUND } from "@tina4/core";
import { Database, getAdapter } from "@tina4/orm";

export const meta = { summary: "Get user by ID", tags: ["Users"] };

export default async function (request: Tina4Request, response: Tina4Response) {
    const db = new Database(getAdapter());
    const user = await db.fetchOne("SELECT * FROM users WHERE id = ?", [request.params.id]);

    if (user) {
        return response(user, HTTP_OK);
    }

    return response.json({ error: "User not found" }, HTTP_NOT_FOUND);
}
