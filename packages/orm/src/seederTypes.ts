/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/** Result of a seed run. */
export interface SeedSummary {
  seeded: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
}

/** Options shared by the table and ORM seed paths. */
export interface SeedOptions {
  overrides?: Record<string, unknown>;
  clear?: boolean;
  seed?: number;
  strict?: boolean;
}
