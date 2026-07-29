/**
 * CLI command: metrics — Rank top code-quality offenders.
 *
 * Exposes the existing static analyzer (cyclomatic complexity, maintainability,
 * large-file, too-many-functions, and the now-precise has_tests) on the CLI as
 * a self-monitoring tool.
 *
 *   tina4nodejs metrics                          # human report, scans src/ (or framework)
 *   tina4nodejs metrics --top 10                 # only the worst 10
 *   tina4nodejs metrics --path packages/core/src # scan a specific directory
 *   tina4nodejs metrics --json                   # machine-readable for CI (ONLY json printed)
 *   tina4nodejs metrics --fail-on warn           # exit 1 if any warn/error offender
 *   tina4nodejs metrics --fail-on error          # exit 1 only on error-severity
 *
 * Returns the intended process exit code (the caller exits). Splitting "compute
 * exit code" from "exit the process" keeps the handler unit-testable.
 */
import { offenders, MetricsEngineError } from "../../../core/src/metrics.js";

type Flags = {
  top: number;
  json: boolean;
  path: string;
  failOn: "warn" | "error" | null;
};

/** Parse `--top N`, `--json`, `--fail-on warn|error`, `--path DIR` out of argv. */
function parseFlags(args: string[]): Flags | { error: string } {
  const flags: Flags = { top: 20, json: false, path: "src", failOn: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--json":
        flags.json = true;
        break;
      case "--top": {
        const v = args[++i];
        if (v === undefined || !/^\d+$/.test(v)) {
          return { error: `--top expects a number (got '${v ?? ""}')` };
        }
        flags.top = parseInt(v, 10);
        break;
      }
      case "--path": {
        const v = args[++i];
        if (v === undefined) return { error: "--path expects a directory" };
        flags.path = v;
        break;
      }
      case "--fail-on": {
        const v = args[++i];
        if (v !== "warn" && v !== "error") {
          return { error: `invalid --fail-on '${v ?? ""}' (use warn or error)` };
        }
        flags.failOn = v;
        break;
      }
      default:
        return { error: `unknown option '${a}'` };
    }
  }

  return flags;
}

/**
 * Run the metrics report. Returns the process exit code; does NOT call
 * process.exit (the bin wrapper does). 0 = ok / below threshold, 1 = gated
 * failure, 2 = bad arguments / analysis error.
 */
export function runMetrics(args: string[] = []): number {
  const parsed = parseFlags(args);
  if ("error" in parsed) {
    console.log(`  ${parsed.error}`);
    return 2;
  }
  const { top, json, path, failOn } = parsed;

  // ONE engine run. Ask for every offender and slice for display: the gate must
  // read the FULL set, not the printed top-N, and the old second call re-ran the
  // whole analysis (its "mtime-cached" comment stopped being true when the
  // in-process analyzer and its cache were deleted -- ADR-0002).
  let result;
  try {
    result = offenders(path, Number.MAX_SAFE_INTEGER);
  } catch (e) {
    if (e instanceof MetricsEngineError) {
      console.error(`  metrics error: ${e.message}`);
      return 2;
    }
    throw e;
  }
  const summary = result.summary;
  const allOffenders = result.offenders;
  const found = allOffenders.slice(0, top);

  const severities = new Set(allOffenders.map((o) => o.severity));
  let exitCode = 0;
  if (failOn === "warn" && (severities.has("warn") || severities.has("error"))) {
    exitCode = 1;
  } else if (failOn === "error" && severities.has("error")) {
    exitCode = 1;
  }

  if (json) {
    // Print ONLY the JSON — machine-readable for CI / tooling.
    console.log(JSON.stringify({ summary, offenders: found }, null, 2));
    return exitCode;
  }

  // ── Human report ──────────────────────────────────────────────────
  const useColor = Boolean(process.stdout.isTTY);
  const c = (text: string, code: string): string =>
    useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
  const sevColor: Record<string, string> = { error: "31", warn: "33", info: "2" }; // red / yellow / dim

  console.log("");
  console.log(`  Tina4 Metrics — ${summary.scan_mode} scan (${summary.scan_root})`);
  console.log(
    `  files: ${summary.files_analyzed}   ` +
      `functions: ${summary.total_functions}   ` +
      `avg complexity: ${summary.avg_complexity}   ` +
      `avg maintainability: ${summary.avg_maintainability}`
  );
  console.log(
    `  offenders: ${summary.total_offenders} total` +
      (found.length ? ` (showing top ${found.length})` : "")
  );
  console.log("");

  if (found.length === 0) {
    console.log("  " + c("✓ no offenders — clean", "32"));
    console.log("");
    return exitCode;
  }

  // Column widths so the table lines up.
  const locs = found.map((o) => `${o.file}:${o.line}`);
  const locW = Math.max("FILE:LINE".length, ...locs.map((s) => s.length));
  const kindW = Math.max("KIND".length, ...found.map((o) => o.kind.length));

  const pad = (s: string, w: number) => s.padEnd(w);
  const header = `  ${pad("#", 3)}  ${pad("SEVERITY", 8)}  ${pad("KIND", kindW)}  ${pad(
    "FILE:LINE",
    locW
  )}  DETAIL`;
  console.log(c(header, "1"));
  console.log("  " + "-".repeat(header.length - 2));
  found.forEach((o, idx) => {
    const i = idx + 1;
    const sevCell = c(pad(o.severity, 8), sevColor[o.severity]);
    console.log(
      `  ${String(i).padStart(3)}  ${sevCell}  ${pad(o.kind, kindW)}  ` +
        `${pad(locs[idx], locW)}  ${o.detail}`
    );
  });
  console.log("");
  return exitCode;
}
