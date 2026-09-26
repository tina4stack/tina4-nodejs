/*
Copyright (c) 2026 Code Infinity
SPDX-License-Identifier: MPL-2.0
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
*/

/**
 * Mutation-proof for the packaged-CLAUDE.md doc-drift gate.
 *
 * Every assertion breaks the thing the gate guards and proves the gate goes
 * RED, then proves the real repo is GREEN -- so it is a gate, not a ghost. The
 * gate resolves names against the LIVE package barrels under REPO_ROOT, so the
 * mutation cases feed a mutated markdown string while the export surface stays
 * the real one.
 */
import {
  REPO_ROOT,
  checkClaudeMd,
  checkMarkdownText,
  packageSurface,
} from "../scripts/auditDocDrift.ts";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name} ${detail}`);
    fail++;
  }
}

const fence = (body: string) => "```ts\n" + body + "\n```\n";

// The real packaged CLAUDE.md must be clean at HEAD (GREEN on the live tree).
const realProblems = checkClaudeMd(REPO_ROOT);
assert("real_claude_md_is_clean", realProblems.length === 0, JSON.stringify(realProblems));

// The gate must actually be reading real, non-empty package surfaces, or a
// clean result would be meaningless (a ghost). Prove the surfaces exist.
const coreSurface = packageSurface("@tina4/core", REPO_ROOT);
const ormSurface = packageSurface("@tina4/orm", REPO_ROOT);
assert("core_surface_is_read", !!coreSurface && coreSurface.names.size > 50 && coreSurface.names.has("Events"));
assert("orm_surface_is_read", !!ormSurface && ormSurface.names.size > 50 && ormSurface.names.has("BaseModel"));

// MUTATION 1 -- a documented value import of a name no package exports (the
// Node twin of the tina4-js `import { mount }` drift) is flagged RED.
const badNamed = checkMarkdownText(fence(`import { mount } from "@tina4/core";`), REPO_ROOT);
assert("flags_nonexistent_named_import",
  badNamed.some((p) => p.includes("mount") && p.includes("not exported by @tina4/core")),
  JSON.stringify(badNamed));

// MUTATION 1 counter -- a real value import is accepted GREEN.
const goodNamed = checkMarkdownText(fence(`import { Events, Queue } from "@tina4/core";`), REPO_ROOT);
assert("accepts_real_named_import", goodNamed.length === 0, JSON.stringify(goodNamed));

// MUTATION 2 -- a documented type import of a name no package exports is RED.
const badType = checkMarkdownText(fence(`import type { NotAType } from "@tina4/orm";`), REPO_ROOT);
assert("flags_nonexistent_type_import",
  badType.some((p) => p.includes("NotAType") && p.includes("not exported by @tina4/orm")),
  JSON.stringify(badType));

// MUTATION 2 counter -- a real type import is accepted GREEN.
const goodType = checkMarkdownText(fence(`import type { Tina4Request, Tina4Response } from "@tina4/core";`), REPO_ROOT);
assert("accepts_real_type_import", goodType.length === 0, JSON.stringify(goodType));

// MUTATION 3 -- a default import from a barrel with no default export is RED.
const badDefault = checkMarkdownText(fence(`import Core from "@tina4/core";`), REPO_ROOT);
assert("flags_default_import_from_barrel",
  badDefault.some((p) => p.includes("has no default export")),
  JSON.stringify(badDefault));

// MUTATION 4 -- a name that lives in a DIFFERENT package is flagged when
// imported from the wrong one (Frond is @tina4/frond, not @tina4/core).
const wrongPkg = checkMarkdownText(fence(`import { Frond } from "@tina4/core";`), REPO_ROOT);
assert("flags_name_from_wrong_package",
  wrongPkg.some((p) => p.includes("Frond") && p.includes("not exported by @tina4/core")),
  JSON.stringify(wrongPkg));

// A relative / non-@tina4 import is ignored (example app code, not a framework claim).
const relative = checkMarkdownText(fence(`import User from "./src/models/User.js";`), REPO_ROOT);
assert("ignores_relative_imports", relative.length === 0, JSON.stringify(relative));

console.log(`Results: ${pass} passed, ${fail} failed`);
process.exitCode = fail > 0 ? 1 : 0;
