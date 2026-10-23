/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * RTC config + signalling require auth by default (ADR-0101, tina4-python#252).
 *
 * The /api/rtc/config route mints a fresh TURN credential on every call and the
 * /ws/rtc/{room} signalling socket relays a call. Left public, anyone can use the
 * operator's TURN server as a relay. Both are secured by default; an app that
 * genuinely wants anonymous calling opts out with TINA4_RTC_REQUIRE_AUTH=false.
 *
 * Answer key: tina4-documentation/plan/v3/fixtures/rtc_auth_contract.json. NO
 * MOCKS - a real realtime() registration, auth read straight off the registered
 * route.
 */
import { Router, defaultRouter } from "../packages/core/src/index.ts";
import { realtime } from "../packages/orm/src/realtime/index.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
  }
}

async function configAuth(value: string | undefined): Promise<boolean> {
  if (value === undefined) delete process.env.TINA4_RTC_REQUIRE_AUTH;
  else process.env.TINA4_RTC_REQUIRE_AUTH = value;
  defaultRouter.clear();
  await realtime({ prefix: "/rtc-t", features: ["calls"] });
  const r = defaultRouter.getRoutes().find((x) => x.pattern.includes("api/rtc/config"));
  if (!r) throw new Error("no config route registered");
  return Boolean(r.secure) && !r.noAuth;
}

async function signalAuth(value: string | undefined): Promise<boolean> {
  if (value === undefined) delete process.env.TINA4_RTC_REQUIRE_AUTH;
  else process.env.TINA4_RTC_REQUIRE_AUTH = value;
  defaultRouter.clear();
  await realtime({ prefix: "/rtc-t", features: ["calls"] });
  const r = Router.getWebSocketRoutes().find((x) => x.pattern.includes("ws/rtc"));
  if (!r) throw new Error("no signalling route registered");
  return Boolean(r.authRequired);
}

console.log("=== RTC require-auth (ADR-0101) ===\n");

check("config route requires auth by default", (await configAuth(undefined)) === true);
check("signalling socket requires auth by default", (await signalAuth(undefined)) === true);
check("require auth false opens the config route", (await configAuth("false")) === false);
check("require auth false opens the signalling socket", (await signalAuth("false")) === false);
check(
  "require auth explicit true secures both",
  (await configAuth("true")) === true && (await signalAuth("true")) === true,
);
check("only explicit falsey opens the route", (await configAuth("yes-please")) === true);

defaultRouter.clear();
delete process.env.TINA4_RTC_REQUIRE_AUTH;
console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
