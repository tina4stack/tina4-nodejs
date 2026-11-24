/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * GHSA-h2mr-m3v3-cq8c: a GraphUrl logged with console.log / util.inspect, or
 * stringified as JSON (directly or inside a logged config object), printed the
 * password twice - in `password` and inside `raw`. DatabaseUrl guards the same
 * way; PHP has __debugInfo/jsonSerialize and Ruby a redacted #inspect.
 */

import { inspect } from "node:util";

import { GraphUrl } from "../packages/orm/src/index.ts";

const URL = "neo4j://graphuser:Pq1Rs2-graph@graphhost:7687/movies";
let passed = 0;
let failed = 0;

/**
 * `why` names the SURFACE that failed, never its text: printing the dump that
 * leaked would put the password in the test log (GHSA-h2mr-m3v3-cq8c).
 */
function check(name: string, ok: boolean, why = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${why ? ` - ${why}` : ""}`);
  }
}

const url = new GraphUrl(URL);

const shown = inspect(url);
check("util.inspect hides the password", !shown.includes("Pq1Rs2"), "the password is in the util.inspect output");
check("util.inspect still names the host", shown.includes("graphhost"), "the host is missing from the util.inspect output");

const json = JSON.stringify(url);
check("JSON.stringify hides the password", !json.includes("Pq1Rs2"), "the password is in the JSON");
check("JSON.stringify still names the host and user", json.includes("graphhost") && json.includes("graphuser"),
  "the host or user is missing from the JSON");

const nested = JSON.stringify({ graph: url });
check("a GraphUrl inside a logged object hides the password", !nested.includes("Pq1Rs2"), "the password is in the nested JSON");

check("the driver still reads the real password", url.password === "Pq1Rs2-graph");
check("the driver still reads the real user", url.username === "graphuser");

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
