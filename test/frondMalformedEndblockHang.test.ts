/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Parity guard for tina4#271. A child template whose last {% endblock %} is
 * malformed (its closing } missing) must not hang the render.
 *
 * Python's extractBlocks looped forever on this (its inner `while...else`
 * skipped the `else` that advances past a malformed open tag on `break`).
 * Node's extractBlocks is already safe -- after the inner loop it runs
 * `if (depth > 0) pos = contentStart;`, advancing past the open tag so the
 * outer loop makes progress -- but the contract must stay locked in all four
 * frameworks, so this renders the exact malformed template and asserts it
 * returns. No mocks: real .twig files in a real temp dir through the real engine.
 *
 * (A regression that reintroduced the loop would hang here; the run-all suite's
 * own timeout surfaces that, which is the intended failure signal.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Frond } from "../packages/frond/src/index.js";

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    // eslint-disable-next-line no-console
    console.error(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "frond-malformed-endblock-"));
fs.writeFileSync(
  path.join(dir, "base.twig"),
  "<html>{% block content %}default{% endblock %}</html>",
);

try {
  it("a malformed {% endblock %} in a child does not hang the render", () => {
    // The final tag is missing its closing brace: `{% endblock %` not `%}`.
    fs.writeFileSync(
      path.join(dir, "page.twig"),
      '{% extends "base.twig" %}\n{% block content %}\n<p>hi</p>\n{% endblock %',
    );
    const out = new Frond(dir).render("page.twig", {});
    assert.equal(typeof out, "string");
  });

  it("a well-formed child still substitutes its block (no regression)", () => {
    fs.writeFileSync(
      path.join(dir, "good.twig"),
      '{% extends "base.twig" %}\n{% block content %}<p>hi</p>{% endblock %}',
    );
    const out = new Frond(dir).render("good.twig", {});
    assert.ok(out.includes("<p>hi</p>"), "child block body must render");
    assert.ok(!out.includes("default"), "parent default must be replaced");
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// eslint-disable-next-line no-console
console.log(`frondMalformedEndblockHang: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
