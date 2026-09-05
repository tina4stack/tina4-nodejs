/**
 * Project plan management — persistent, human-readable task state.
 *
 * Ported from tina4_python/dev_admin/plan.py (master reference).
 * A plan is a markdown file under plan/ at the project root with sections
 * for title, goal, steps (checkboxes), and notes. Exactly one plan is
 * "current" at a time, recorded in plan/.current.
 *
 * Byte-for-byte compatible with Python's plan/*.md storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PLAN_DIR = "plan";
const CURRENT_FILE = ".current";
const ARCHIVE_SUBDIR = "done";

export interface PlanStep {
  text: string;
  done: boolean;
  index?: number;
}

export interface ParsedPlan {
  title: string;
  goal: string;
  steps: PlanStep[];
  notes: string;
}

export interface PlanSummary {
  name: string;
  title: string;
  steps_total: number;
  steps_done: number;
  is_current: boolean;
  /** Path relative to project root — lets the SPA open the right file
   *  regardless of which dir the plan came from (plan/ vs .tina4/plans/). */
  path: string;
}

export interface ExecutionSummary {
  created: string[];
  patched: string[];
  migrations: string[];
  total: number;
}

export interface CurrentPlan {
  current: string | null;
  title?: string;
  goal?: string;
  steps?: PlanStep[];
  next_step?: PlanStep | null;
  notes?: string;
  progress?: { done: number; total: number };
  execution?: ExecutionSummary;
  warning?: string;
}

const STEP_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;

function projectRoot(): string {
  return path.resolve(process.cwd());
}

function planDir(): string {
  const p = path.join(projectRoot(), PLAN_DIR);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function currentPointer(): string {
  return path.join(planDir(), CURRENT_FILE);
}

function archiveDir(): string {
  const p = path.join(planDir(), ARCHIVE_SUBDIR);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function slugify(title: string): string {
  const slug = (title || "").trim().toLowerCase()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 80) || `plan-${Math.floor(Date.now() / 1000)}`;
}

function parse(text: string): ParsedPlan {
  const lines = text.split(/\r?\n/);
  let title = "";
  let goal = "";
  const steps: PlanStep[] = [];
  const notesLines: string[] = [];
  let section: "steps" | "notes" | "other" | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!title && line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    const low = line.trim().toLowerCase();
    if (low.startsWith("goal:") && !goal) {
      goal = line.split(":").slice(1).join(":").trim();
      continue;
    }
    if (low === "## steps") {
      section = "steps";
      continue;
    }
    if (low === "## notes") {
      section = "notes";
      continue;
    }
    if (line.startsWith("## ")) {
      section = "other";
      continue;
    }
    if (section === "steps") {
      const m = line.match(STEP_RE);
      if (m) {
        steps.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
      }
    } else if (section === "notes" && line.trim()) {
      notesLines.push(line);
    }
  }

  return { title, goal, steps, notes: notesLines.join("\n").trim() };
}

function render(planObj: ParsedPlan): string {
  const parts: string[] = [`# ${planObj.title || "Untitled plan"}`, ""];
  if (planObj.goal) {
    parts.push(`Goal: ${planObj.goal}`, "");
  }
  parts.push("## Steps", "");
  for (const step of planObj.steps || []) {
    const box = step.done ? "x" : " ";
    parts.push(`- [${box}] ${(step.text || "").trim()}`);
  }
  const notes = (planObj.notes || "").trim();
  if (notes) {
    parts.push("", "## Notes", "", notes);
  }
  return parts.join("\n") + "\n";
}

function loadParsed(name: string): { path: string; plan: ParsedPlan } {
  if (!name.endsWith(".md")) name += ".md";
  const p = path.join(planDir(), name);
  if (!fs.existsSync(p)) {
    throw new Error(`No such plan: ${name}`);
  }
  return { path: p, plan: parse(fs.readFileSync(p, "utf-8")) };
}

function fleshPrompt(title: string, goal: string, existing: string[], prompt: string): { system: string; user: string } {
  const system =
    "You are Tina4, a coding planner embedded in the Tina4 dev " +
    "admin. Return ONLY a JSON array of short imperative step " +
    "strings (no prose, no code-fences, no numbering). 3-8 steps, " +
    "each referencing concrete files/routes/migrations. Example: " +
    '["Create src/orm/Duck.ts with id/name/sighted_at", ' +
    '"Add migration 001_create_ducks.sql", ' +
    '"Add GET/POST/PUT/DELETE /api/ducks routes in ' +
    'src/routes/ducks.ts"]';
  const parts: string[] = [`Plan title: ${title}`];
  if (goal) parts.push(`Goal: ${goal}`);
  if (existing.length) parts.push("Existing steps (don't repeat):\n- " + existing.join("\n- "));
  if (prompt) parts.push(`Extra context from caller: ${prompt}`);
  parts.push("Reply with ONLY the JSON array — no explanation, no markdown fences.");
  return { system, user: parts.join("\n\n") };
}

async function fetchFleshReply(aiUrl: string, aiModel: string, prompts: { system: string; user: string }): Promise<{ reply: string } | { error: string }> {
  try {
    const response = await fetch(aiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: aiModel, stream: false, messages: [
        { role: "system", content: prompts.system },
        { role: "user", content: prompts.user },
      ] }),
      signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as Record<string, unknown>;
    const message = (result.message as Record<string, unknown> | undefined) || {};
    return { reply: ((message.content as string) || (result.response as string) || "") };
  } catch (error) {
    return { error: `AI backend unreachable: ${(error as Error).message}` };
  }
}

function parseFleshReply(reply: string): string[] {
  let body = reply.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^`+/, "").replace(/`+$/, "");
    if (body.toLowerCase().startsWith("json")) body = body.slice(4).trim();
    body = body.trim();
  }
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) return parsed.map((step) => String(step).trim()).filter(Boolean);
  } catch {
    // Fall back to markdown-style lists below.
  }
  const proposed: string[] = [];
  for (const line of reply.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (match) proposed.push(match[1].trim());
  }
  return proposed;
}

function addFleshSteps(target: string, existing: string[], proposed: string[]): string[] {
  const existingLc = new Set(existing.map((step) => step.toLowerCase()));
  const added: string[] = [];
  for (const step of proposed) {
    if (existingLc.has(step.toLowerCase())) continue;
    const result = Plan.addStep(step, target);
    if (result.ok) {
      added.push(step);
      existingLc.add(step.toLowerCase());
    }
  }
  return added;
}

// ── Plan namespace ────────────────────────────────────────────

export const Plan = {
  /**
   * All plan files — merged from `plan/` (user-curated canonical) and
   * `.tina4/plans/` (where the Rust supervisor's planner writes).
   *
   * Two directories exist because of a historic split: the framework
   * treats `plan/` as the canonical project location, but the Rust agent's
   * planner writes to `.tina4/plans/` (alongside other AI-state artefacts
   * like chat history). Until those are unified we read both so plans
   * created either way are discoverable. Dedup by filename when a plan
   * exists in both — `plan/` wins on collision.
   *
   * Newest-first by filename (Rust planner uses unix-timestamp prefixes).
   */
  listPlans(): PlanSummary[] {
    const root = projectRoot();
    const current = Plan.currentName() || "";

    // Order matters for dedup: user-curated first.
    const dirs: string[] = [planDir()];
    const rustPlans = path.join(root, ".tina4", "plans");
    if (fs.existsSync(rustPlans) && fs.statSync(rustPlans).isDirectory()) {
      dirs.push(rustPlans);
    }

    const seen = new Set<string>();
    const out: PlanSummary[] = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
      } catch {
        continue;  // dir disappeared between exists() and readdir — skip
      }
      for (const name of entries) {
        if (seen.has(name)) continue;  // plan/ wins over .tina4/plans/ on name clash
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (!stat.isFile()) continue;
        seen.add(name);
        const parsed = parse(fs.readFileSync(full, "utf-8"));
        const total = parsed.steps.length;
        const done = parsed.steps.filter((s) => s.done).length;
        out.push({
          name,
          title: parsed.title || name.replace(/\.md$/, ""),
          steps_total: total,
          steps_done: done,
          is_current: name === current,
          // Relative path from project root — lets the SPA open the right
          // file in the editor regardless of source dir.
          path: path.relative(root, full),
        });
      }
    }
    // Newest first by name (filenames start with unix timestamps).
    out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    return out;
  },

  currentName(): string {
    const ptr = currentPointer();
    if (!fs.existsSync(ptr)) return "";
    return fs.readFileSync(ptr, "utf-8").trim();
  },

  setCurrent(name: string): { ok: boolean; current?: string; error?: string } {
    name = name.trim();
    if (!name.endsWith(".md")) name += ".md";
    const p = path.join(planDir(), name);
    if (!fs.existsSync(p)) return { ok: false, error: `No such plan: ${name}` };
    fs.writeFileSync(currentPointer(), name, "utf-8");
    return { ok: true, current: name };
  },

  clearCurrent(): { ok: boolean } {
    const p = currentPointer();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  },

  current(): CurrentPlan {
    const name = Plan.currentName();
    if (!name) return { current: null };
    const p = path.join(planDir(), name);
    if (!fs.existsSync(p)) {
      Plan.clearCurrent();
      return { current: null, warning: `Current pointer referenced missing file: ${name}` };
    }
    const parsed = parse(fs.readFileSync(p, "utf-8"));
    const indexedSteps: PlanStep[] = parsed.steps.map((s, i) => ({ index: i, text: s.text, done: s.done }));
    const nextStep = indexedSteps.find((s) => !s.done) || null;
    return {
      current: name,
      title: parsed.title,
      goal: parsed.goal,
      steps: indexedSteps,
      next_step: nextStep,
      notes: parsed.notes,
      progress: {
        done: indexedSteps.filter((s) => s.done).length,
        total: indexedSteps.length,
      },
      execution: Plan.summariseExecution(name),
    };
  },

  read(name: string): ParsedPlan & { name?: string; error?: string } {
    if (!name.endsWith(".md")) name += ".md";
    const p = path.join(planDir(), name);
    if (!fs.existsSync(p)) return { title: "", goal: "", steps: [], notes: "", error: `No such plan: ${name}` };
    return { ...parse(fs.readFileSync(p, "utf-8")), name };
  },

  create(
    title: string,
    goal = "",
    steps: string[] = [],
    makeCurrent = true,
  ): { ok: boolean; name?: string; title?: string; is_current?: boolean; error?: string } {
    title = (title || "").trim();
    if (!title) return { ok: false, error: "title is required" };
    const stem = slugify(title);
    const name = `${stem}.md`;
    const p = path.join(planDir(), name);
    if (fs.existsSync(p)) {
      return {
        ok: false,
        error: `Plan already exists: ${name}. Pick a different title or edit the existing one.`,
      };
    }
    const planObj: ParsedPlan = {
      title,
      goal: goal.trim(),
      steps: (steps || []).filter((s) => s && s.trim()).map((s) => ({ text: s.trim(), done: false })),
      notes: "",
    };
    fs.writeFileSync(p, render(planObj), "utf-8");
    if (makeCurrent) fs.writeFileSync(currentPointer(), name, "utf-8");
    return { ok: true, name, title, is_current: makeCurrent };
  },

  completeStep(index: number, name = ""): Record<string, unknown> {
    name = name || Plan.currentName();
    if (!name) return { ok: false, error: "No current plan and no name given" };
    let loaded;
    try {
      loaded = loadParsed(name);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { path: p, plan } = loaded;
    if (!(index >= 0 && index < plan.steps.length)) {
      return { ok: false, error: `Step index ${index} out of range (0..${plan.steps.length - 1})` };
    }
    plan.steps[index].done = true;
    fs.writeFileSync(p, render(plan), "utf-8");
    const remaining = plan.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.done);
    return {
      ok: true,
      completed: plan.steps[index].text,
      remaining: remaining.length,
      next_step: remaining.length > 0 ? plan.steps[remaining[0].i].text : null,
    };
  },

  uncompleteStep(index: number, name = ""): Record<string, unknown> {
    name = name || Plan.currentName();
    if (!name) return { ok: false, error: "No current plan and no name given" };
    let loaded;
    try {
      loaded = loadParsed(name);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { path: p, plan } = loaded;
    if (!(index >= 0 && index < plan.steps.length)) {
      return { ok: false, error: `Step index ${index} out of range` };
    }
    plan.steps[index].done = false;
    fs.writeFileSync(p, render(plan), "utf-8");
    return { ok: true, step: plan.steps[index].text };
  },

  addStep(text: string, name = ""): Record<string, unknown> {
    text = (text || "").trim();
    if (!text) return { ok: false, error: "text is required" };
    name = name || Plan.currentName();
    if (!name) return { ok: false, error: "No current plan and no name given" };
    let loaded;
    try {
      loaded = loadParsed(name);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { path: p, plan } = loaded;
    plan.steps.push({ text, done: false });
    fs.writeFileSync(p, render(plan), "utf-8");
    return { ok: true, step: text, index: plan.steps.length - 1 };
  },

  appendNote(text: string, name = ""): Record<string, unknown> {
    text = (text || "").trim();
    if (!text) return { ok: false, error: "text is required" };
    name = name || Plan.currentName();
    if (!name) return { ok: false, error: "No current plan and no name given" };
    let loaded;
    try {
      loaded = loadParsed(name);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const { path: p, plan } = loaded;
    const existing = (plan.notes || "").trim();
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    plan.notes = (existing + `\n- [${stamp}] ${text}`).trim();
    fs.writeFileSync(p, render(plan), "utf-8");
    return { ok: true, appended: text };
  },

  // ── Execution ledger ──────────────────────────────────────────

  recordAction(action: string, filePath: string, note = ""): void {
    const lp = ledgerPath();
    if (!lp) return;
    let entries: Array<Record<string, unknown>> = [];
    if (fs.existsSync(lp)) {
      try {
        entries = JSON.parse(fs.readFileSync(lp, "utf-8"));
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = [];
      }
    }
    entries.push({
      t: Math.floor(Date.now() / 1000),
      action,
      path: filePath,
      note,
    });
    if (entries.length > 500) entries = entries.slice(-500);
    try {
      fs.writeFileSync(lp, JSON.stringify(entries, null, 2), "utf-8");
    } catch {
      // best-effort
    }
  },

  summariseExecution(name = ""): ExecutionSummary {
    const lp = ledgerPath(name);
    if (!lp || !fs.existsSync(lp)) {
      return { created: [], patched: [], migrations: [], total: 0 };
    }
    let entries: Array<Record<string, unknown>>;
    try {
      entries = JSON.parse(fs.readFileSync(lp, "utf-8"));
    } catch {
      return { created: [], patched: [], migrations: [], total: 0 };
    }
    const created: string[] = [];
    const patched: string[] = [];
    const migrations: string[] = [];
    for (const e of entries) {
      const action = e.action as string;
      const p = e.path as string;
      if (!p) continue;
      const bucket =
        action === "migration" ? migrations :
        action === "created" ? created :
        action === "patched" ? patched : null;
      if (bucket && !bucket.includes(p)) bucket.push(p);
    }
    return {
      created: created.slice(-20),
      patched: patched.slice(-20),
      migrations: migrations.slice(-20),
      total: entries.length,
    };
  },

  async flesh(name = "", prompt = ""): Promise<Record<string, unknown>> {
    const target = (name || "").trim() || Plan.currentName();
    if (!target) return { ok: false, error: "No current plan and no name given" };
    const currentPlan = Plan.read(target);
    if (currentPlan.error) return { ok: false, error: currentPlan.error };

    const existing = (currentPlan.steps || []).map((s) => s.text || "");
    const title = currentPlan.title || target;
    const goal = currentPlan.goal || "";

    const aiUrl = process.env.TINA4_AI_URL || "http://localhost:11437/api/chat";
    const aiModel = process.env.TINA4_AI_MODEL || "qwen2.5-coder:14b";
    const prompts = fleshPrompt(title, goal, existing, prompt);
    const fetched = await fetchFleshReply(aiUrl, aiModel, prompts);
    if ("error" in fetched) return { ok: false, error: fetched.error };
    const proposed = parseFleshReply(fetched.reply);

    if (proposed.length === 0) {
      return { ok: false, error: "AI returned no usable steps", raw_reply: fetched.reply.slice(0, 400) };
    }
    const added = addFleshSteps(target, existing, proposed);

    return {
      ok: true,
      plan: target,
      added,
      added_count: added.length,
      proposed_count: proposed.length,
      plan_after: Plan.read(target),
    };
  },

  archive(name = ""): Record<string, unknown> {
    name = name || Plan.currentName();
    if (!name) return { ok: false, error: "No current plan and no name given" };
    if (!name.endsWith(".md")) name += ".md";
    const src = path.join(planDir(), name);
    if (!fs.existsSync(src)) return { ok: false, error: `No such plan: ${name}` };
    let dest = path.join(archiveDir(), name);
    if (fs.existsSync(dest)) {
      dest = path.join(archiveDir(), `${Math.floor(Date.now() / 1000)}-${name}`);
    }
    fs.renameSync(src, dest);
    if (Plan.currentName() === name) Plan.clearCurrent();
    return { ok: true, archived_to: path.relative(projectRoot(), dest) };
  },
};

function ledgerPath(name = ""): string | null {
  name = name || Plan.currentName();
  if (!name) return null;
  if (!name.endsWith(".md")) name += ".md";
  return path.join(planDir(), `${name.slice(0, -3)}.log.json`);
}
