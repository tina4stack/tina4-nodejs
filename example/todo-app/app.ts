/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import { createServer } from "@tina4/core";
import { initDatabase } from "@tina4/orm";

const db = initDatabase("sqlite:todos.db");

createServer({ port: 7148 });
