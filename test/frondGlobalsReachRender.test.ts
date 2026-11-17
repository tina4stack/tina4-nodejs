/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * A template global, filter or test registered through the public static API
 * reaches every page res.render() produces, whenever it is registered
 * (ADR-0106 for globals, ADR-0107 for filters and tests, which were also
 * drained into an engine once, at construction).
 *
 * The engine copied Frond's class globals once, in its constructor, so a
 * Frond.addGlobal() made after res.render's engine existed (after the first
 * render) never reached a page. The auto-wired t() was put on startServer's
 * OWN engine, not on the one res.render builds, so {{ t("key") }} rendered
 * empty in every res.render page. This file boots a REAL server via the REAL
 * startServer() and renders real templates through real routes over real HTTP.
 * No mocks.
 *
 * Same case names in all four:
 *   tina4-python/tests/test_frond_globals_reach_render.py
 *   tina4-php/tests/FrondGlobalsReachRenderTest.php
 *   tina4-ruby/spec/frond_globals_reach_render_spec.rb
 *
 * Run with: npx tsx test/frondGlobalsReachRender.test.ts
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, get, getFrond, TestClient } from "../packages/core/src/index.ts";
import { Frond } from "../packages/frond/src/index.ts";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

process.env.TINA4_NO_BROWSER = "true";
if (Buffer.byteLength(process.env.TINA4_SECRET ?? "", "utf8") < 32) {
  process.env.TINA4_SECRET = "frond-globals-reach-render-secret-0123456789";
}
process.env.TINA4_LOCALE = "en";
delete process.env.TINA4_LOCALE_DIR;

const root = mkdtempSync(join(tmpdir(), "tina4-globals-render-"));
mkdirSync(join(root, "src/templates"), { recursive: true });
mkdirSync(join(root, "src/locales"), { recursive: true });
const templates: Record<string, string> = {
  "globals.twig": "[{{ early }}][{{ late }}][{{ shared }}]",
  "flag.twig": "{% if is_admin %}admin{% else %}guest{% endif %}",
  "call.twig": `{{ shout("hi") }}`,
  "filter.twig": `{{ "hi"|loud }}`,
  "filter_late.twig": `{{ "HI"|hush }}`,
  "filter_local.twig": `{{ "x"|mute }}`,
  "filter_tone.twig": `{{ "x"|tone }}`,
  "test.twig": "{% if 4 is quad %}yes{% else %}no{% endif %}",
  "test_late.twig": "{% if 5 is quint %}yes{% else %}no{% endif %}",
  "test_local.twig": "{% if 1 is never %}yes{% else %}no{% endif %}",
  "greeting.twig": `{{ t("greeting") }}`,
  "welcome.twig": `{{ t("welcome", {"name": "Ana"}) }}`,
};
for (const [name, source] of Object.entries(templates)) {
  writeFileSync(join(root, "src/templates", name), source);
}
writeFileSync(join(root, "src/locales/en.json"), JSON.stringify({ greeting: "Hello", welcome: "Welcome, {name}!" }));

for (const name of Object.keys(templates)) {
  get(`/${name.replace(/\.twig$/, "")}`, async (_request: any, response: any) => response.render(name));
}

const PORT = 3963;
const page = async (path: string): Promise<string> => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return response.status === 200 ? await response.text() : `HTTP ${response.status}`;
};

async function main() {
  Frond.clearRegistry();
  process.chdir(root);

  // Case 1 runs before ANY render in this process, so res.render's engine does
  // not exist yet when the global is registered.
  Frond.addGlobal("early", "E");
  Frond.addFilter("loud", (value: unknown) => String(value).toUpperCase());
  Frond.addTest("quad", (value: unknown) => value === 4);
  const firstRender = await new TestClient().get("/globals"); // builds res.render's engine
  assert(
    "class global registered before first render reaches render",
    firstRender.text() === "[E][][]",
    firstRender.text(),
  );

  // startServer auto-wires t() AFTER that first render already built the engine.
  const server = await startServer({ port: PORT, basePath: root, noBrowser: true });
  try {
    {
      const before = await page("/globals");
      Frond.addGlobal("late", "L");
      const after = await page("/globals");
      assert(
        "class global registered after first render reaches render",
        before === "[E][][]" && after === "[E][L][]",
        `${before} -> ${after}`,
      );
    }
    {
      const before = await page("/flag");
      Frond.addGlobal("is_admin", () => true); // ADR-0085 auto-call
      const after = await page("/flag");
      assert(
        "zero arg class global registered after first render is called",
        before === "guest" && after === "admin",
        `${before} -> ${after}`,
      );
    }
    {
      const before = await page("/call");
      Frond.addGlobal("shout", (text: string) => text.toUpperCase());
      const after = await page("/call");
      assert(
        "callable class global registered after first render is called",
        before === "" && after === "HI",
        `${before} -> ${after}`,
      );
    }

    const greeting = await page("/greeting");
    assert("auto wired t translates a key", greeting === "Hello", greeting);
    assert("auto wired t registered after first render reaches render", greeting === "Hello", greeting);

    const welcome = await page("/welcome");
    assert("auto wired t accepts a params map", welcome === "Welcome, Ana!", welcome);

    const otherEngineGreeting = new Frond(join(root, "src/templates")).render("greeting.twig");
    assert("auto wired t reaches every engine", otherEngineGreeting === "Hello", otherEngineGreeting);

    {
      const otherEngine = new Frond(join(root, "src/templates"));
      otherEngine.addGlobal("shared", "LEAK");
      const rendered = await page("/globals");
      const other = otherEngine.render("globals.twig");
      assert(
        "instance global on another engine does not leak into render",
        rendered === "[E][L][]" && other === "[E][L][LEAK]",
        `${rendered} / ${other}`,
      );
    }
    {
      Frond.addGlobal("shared", "class");
      const classValue = await page("/globals");
      (await getFrond()).addGlobal("shared", "instance"); // res.render's own engine
      const instanceValue = await page("/globals");
      const fresh = new Frond(join(root, "src/templates")).render("globals.twig");
      assert(
        "instance global overrides class global",
        classValue === "[E][L][class]" && instanceValue === "[E][L][instance]" && fresh === "[E][L][class]",
        `${classValue} / ${instanceValue} / ${fresh}`,
      );
    }

    // ── Filters and tests (ADR-0107) ─────────────────────────────────────
    {
      const filtered = await page("/filter");
      assert("class filter registered before first render reaches render", filtered === "HI", filtered);
      const tested = await page("/test");
      assert("class test registered before first render reaches render", tested === "yes", tested);
    }
    {
      const before = await page("/filter_late");
      Frond.addFilter("hush", (value: unknown) => String(value).toLowerCase());
      const after = await page("/filter_late");
      assert(
        "class filter registered after first render reaches render",
        before === "HI" && after === "hi",
        `${before} -> ${after}`,
      );
    }
    {
      const before = await page("/test_late");
      Frond.addTest("quint", (value: unknown) => value === 5);
      const after = await page("/test_late");
      assert(
        "class test registered after first render reaches render",
        before === "no" && after === "yes",
        `${before} -> ${after}`,
      );
    }
    {
      const otherEngine = new Frond(join(root, "src/templates"));
      otherEngine.addFilter("mute", () => "LEAK");
      const rendered = await page("/filter_local");
      const other = otherEngine.render("filter_local.twig");
      assert(
        "instance filter on another engine does not leak into render",
        rendered === "x" && other === "LEAK",
        `${rendered} / ${other}`,
      );
    }
    {
      const otherEngine = new Frond(join(root, "src/templates"));
      otherEngine.addTest("never", () => true);
      const rendered = await page("/test_local");
      const other = otherEngine.render("test_local.twig");
      assert(
        "instance test on another engine does not leak into render",
        rendered === "no" && other === "yes",
        `${rendered} / ${other}`,
      );
    }
    {
      Frond.addFilter("tone", () => "class");
      const classValue = await page("/filter_tone");
      (await getFrond()).addFilter("tone", () => "instance"); // res.render's own engine
      const instanceValue = await page("/filter_tone");
      Frond.addFilter("tone", () => "class again"); // a later class change
      const stillInstance = await page("/filter_tone");
      const fresh = new Frond(join(root, "src/templates")).render("filter_tone.twig");
      assert(
        "instance filter overrides class filter",
        classValue === "class" && instanceValue === "instance" && stillInstance === "instance" && fresh === "class again",
        `${classValue} / ${instanceValue} / ${stillInstance} / ${fresh}`,
      );
    }
  } finally {
    server.close();
    Frond.clearRegistry();
    process.chdir(join(import.meta.dirname, ".."));
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n==================================================`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`==================================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
