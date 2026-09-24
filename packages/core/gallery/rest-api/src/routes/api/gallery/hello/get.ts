/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Gallery: REST API — simple JSON GET endpoint. */
import type { Tina4Request, Tina4Response } from "tina4-nodejs";

export default async function (req: Tina4Request, res: Tina4Response) {
  return res.json({ message: "Hello from Tina4!", method: "GET" });
}
