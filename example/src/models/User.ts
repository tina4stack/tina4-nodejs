/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

export default class User {
    static tableName = "users";
    static fields = {
        id:         { type: "integer" as const, primaryKey: true, autoIncrement: true },
        name:       { type: "string" as const,  required: true, maxLength: 100 },
        email:      { type: "string" as const,  required: true, maxLength: 255 },
        role:       { type: "string" as const,  default: "user", maxLength: 50 },
        active:     { type: "boolean" as const, default: true },
        created_at: { type: "datetime" as const },
    };
}
