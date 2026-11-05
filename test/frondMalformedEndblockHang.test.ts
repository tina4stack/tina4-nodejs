/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Parity guard for tina4#271 + tina4#286/#290. A child template whose
 * {% block %} is never closed -- or whose last {% endblock %} is cut short to
 * `{% endblock %` (its closing `}` missing, so the tokenizer never produces the
 * tag) -- must FAIL LOUD (tina4#286/#290), and must stay bounded so a
 * reintroduced hang surfaces via the run-all suite timeout rather than locking
 * the render (tina4#271). No mocks: real .twig files in a real temp dir through
 * the real engine.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Frond, FrondSyntaxError } from "../packages/frond/src/index.js";

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
  it("a cut-short {% endblock % in a child fails loud", () => {
    // The final tag is missing its closing brace: `{% endblock %` not `%}`.
    fs.writeFileSync(
      path.join(dir, "page.twig"),
      '{% extends "base.twig" %}\n{% block content %}\n<p>hi</p>\n{% endblock %',
    );
    assert.throws(
      () => new Frond(dir).render("page.twig", {}),
      (err: unknown) => err instanceof FrondSyntaxError && /content/.test((err as Error).message),
    );
  });

  it("an unclosed {% block %} in a child fails loud", () => {
    fs.writeFileSync(
      path.join(dir, "unclosed.twig"),
      '{% extends "base.twig" %}\n{% block content %}\n<p>hi</p>\n',
    );
    assert.throws(
      () => new Frond(dir).render("unclosed.twig", {}),
      FrondSyntaxError,
    );
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
