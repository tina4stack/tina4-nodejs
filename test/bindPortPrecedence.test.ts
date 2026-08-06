/**
 * TINA4_PORT MUST BEAT BARE PORT, ON THE PATH THAT BINDS THE SOCKET.
 *
 * The CLI documents CLI flag > TINA4_PORT > PORT > default and labels bare PORT
 * "Legacy bare server port (prefer TINA4_PORT)". resolvePortAndHost read PORT
 * and nothing else, so TINA4_PORT was IGNORED on the path that binds - while
 * devAdmin.ts, three files away, read TINA4_PORT first. One framework, two
 * answers for the same variable.
 *
 * Bare PORT is DEPRECATED, not removed: still honoured so no deployment breaks,
 * and warned so the migration happens. Removal is 3.14.
 *
 * Identical case names in all four frameworks:
 *   tina4-python/tests/test_bind_port_precedence.py
 *   tina4-php/tests/BindPortPrecedenceTest.php
 *   tina4-ruby/spec/bind_port_precedence_spec.rb
 */
import { resolvePortAndHost } from "../packages/core/src/server.js";

let passed = 0;
let failed = 0;
function assert(label: string, condition: boolean) {
  console.log((condition ? "  PASS " : "  FAIL ") + label);
  if (condition) passed++;
  else failed++;
}

function clean() {
  delete process.env.TINA4_PORT;
  delete process.env.PORT;
  delete process.env.TINA4_HOST;
  delete process.env.HOST;
}

clean();
process.env.TINA4_PORT = "45001";
process.env.PORT = "9999";
assert("tina4 port wins over bare port", resolvePortAndHost().port === 45001);

clean();
process.env.PORT = "9999";
assert("bare port is still honoured", resolvePortAndHost().port === 9999);

clean();
process.env.TINA4_PORT = "45001";
process.env.PORT = "9999";
assert("an explicit argument beats both", resolvePortAndHost({ port: 6000 }).port === 6000);

clean();
assert("the default applies when nothing is set", resolvePortAndHost().port === 7148);

clean();
process.env.TINA4_PORT = "not-a-port";
process.env.PORT = "9999";
assert("a non numeric value falls through", resolvePortAndHost().port === 9999);

clean();
process.env.TINA4_HOST = "127.0.0.1";
process.env.HOST = "0.0.0.0";
assert("tina4 host wins over bare host", resolvePortAndHost().host === "127.0.0.1");

clean();
console.log(`\n  Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
