/**
 * Child process for test/mailTransportTls.test.ts.
 *
 * Runs a list of Messenger actions in a FRESH Node process, so the parent can
 * decide what this process trusts: NODE_EXTRA_CA_CERTS is read once, when Node
 * builds its root store at start-up, and cannot be changed afterwards. That is
 * the standard way an app trusts a private CA (ADR-0071 section 3).
 *
 * Input:  MAIL_TEST_INPUT = JSON array of { id, action, messenger, to?, subject? }
 * Output: one line "@@RESULT@@<json>" mapping each id to its outcome.
 */
import { Messenger } from "../../packages/core/src/messenger.ts";

interface MailAction {
  id: string;
  action: "send" | "testConnection" | "inbox" | "findSubject";
  messenger: Record<string, unknown>;
  to?: string;
  subject?: string;
}

const actions = JSON.parse(process.env.MAIL_TEST_INPUT ?? "[]") as MailAction[];
const results: Record<string, unknown> = {};

// A step that hangs (a plaintext client waiting for a greeting a TLS server never
// sends) must not hang the whole child: it is reported as a timeout instead.
const STEP_TIMEOUT_MS = 15_000;

async function runStep(step: MailAction): Promise<unknown> {
  const messenger = new Messenger(step.messenger);
  if (step.action === "send") return messenger.send(step.to ?? "", step.subject ?? "", "adr-0071");
  if (step.action === "testConnection") return messenger.testConnection();
  if (step.action === "inbox") return { count: (await messenger.inbox("INBOX", 5)).length };
  // A mail another step just sent: poll the mailbox until it shows up.
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await messenger.inbox("INBOX", 50)).some((message) => message.subject === step.subject)) return { found: true };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { found: false };
}

for (const step of actions) {
  try {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`step timed out after ${STEP_TIMEOUT_MS} ms`), { name: "StepTimeout" })), STEP_TIMEOUT_MS);
    });
    try {
      results[step.id] = await Promise.race([runStep(step), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    results[step.id] = { errorClass: failure.name, error: failure.message };
  }
}

process.stdout.write("\n@@RESULT@@" + JSON.stringify(results) + "\n");
// A hung step leaves its socket open; the verdict is written, so leave now.
process.exit(0);
