/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

export default class Todo {
    static tableName = "todo";
    static fields = {
        id:         { type: "integer" as const, primaryKey: true, autoIncrement: true },
        title:      { type: "string" as const, required: true },
        completed:  { type: "integer" as const, default: 0 },
        created_at: { type: "datetime" as const },
    };
}
