/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * The one way a test file reports an unexpected error: the error's name and
 * message, with any URL userinfo (`//user:password@`) replaced by `//***@`.
 *
 * Never the raw error object or its stack: a driver error can quote the
 * connection URL a test built from TINA4_TEST_*_PASSWORD, and the log is
 * public in CI (CodeQL js/clear-text-logging).
 */
export function safeErrorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.replace(/\/\/[^@/\s]*@/g, "//***@");
}
