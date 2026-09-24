/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

import { startServer } from "@tina4/core";
import { initDatabase } from "@tina4/orm";

const db = initDatabase("sqlite:example.db");

const port = parseInt(process.env.PORT || "7149", 10);
const host = process.env.HOST || "0.0.0.0";
startServer({ port, host });
