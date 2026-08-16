// Thin dev-admin adapter for the native `tina4 metrics` engine (ADR-0054).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let lastScanRoot = "";

export class MetricsEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsEngineError";
  }
}
const INSTALL_HINT = "update the native tina4 CLI: https://tina4.com/cli";
const SUMMARY_KEYS = ["files_analyzed", "total_functions", "avg_complexity", "avg_maintainability"];
const FILE_KEYS = ["path", "loc", "avg_complexity", "maintainability", "has_referencing_test"];
const FUNCTION_KEYS = ["name", "file", "line", "complexity", "loc"];

function containsTypeScript(directory: string): boolean {
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() ? containsTypeScript(target) : /\.[cm]?[jt]sx?$/.test(entry.name)) return true;
  }
  return false;
}

function resolveTarget(root: string = "src"): [string, string] {
  const resolved = containsTypeScript(root)
    ? path.resolve(root)
    : path.dirname(fileURLToPath(import.meta.url));
  const mode = containsTypeScript(root) ? "project" : "framework";
  lastScanRoot = resolved;
  return [resolved, mode];
}

export function enginePath(): string | null {
  const names = process.platform === "win32" ? ["tina4.exe", "tina4"] : ["tina4"];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (!fs.statSync(candidate).isFile()) continue;
        const descriptor = fs.openSync(candidate, "r");
        const header = Buffer.alloc(2);
        fs.readSync(descriptor, header, 0, 2, 0);
        fs.closeSync(descriptor);
        if (header.toString("latin1") !== "#!") return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

function runEngine(target: string): Record<string, any> {
  const binary = enginePath();
  if (!binary) throw new MetricsEngineError(`tina4 not found on PATH - ${INSTALL_HINT}`);
  const processResult = spawnSync(binary, ["metrics", "--path", target, "--json"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (processResult.error) {
    throw new MetricsEngineError(`could not run ${binary}: ${processResult.error.message}`);
  }
  if (processResult.status !== 0) {
    const detail = (processResult.stderr || processResult.stdout || "").trim().split("\n")[0];
    throw new MetricsEngineError(`tina4 metrics failed on ${target}: ${detail || processResult.status}`);
  }
  try {
    const payload = JSON.parse(processResult.stdout);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("non-object payload");
    }
    return payload;
  } catch (error) {
    throw new MetricsEngineError(`tina4 metrics returned unreadable JSON: ${(error as Error).message}`);
  }
}

function requireArray(payload: Record<string, any>, key: string): Record<string, any>[] {
  if (!Array.isArray(payload[key])) {
    throw new MetricsEngineError(`engine payload has no usable '${key}' - ${INSTALL_HINT}`);
  }
  return payload[key];
}

export function fullAnalysis(root: string = "src"): Record<string, any> {
  const [resolved, scanMode] = resolveTarget(root);
  const payload = runEngine(resolved);
  const summary = payload.summary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new MetricsEngineError(`engine payload has no usable 'summary' - ${INSTALL_HINT}`);
  }
  const fileMetrics = requireArray(payload, "file_metrics");
  const functions = requireArray(payload, "most_complex_functions");
  const missingSummary = SUMMARY_KEYS.filter((key) => !(key in summary));
  if (missingSummary.length) throw new MetricsEngineError(`engine summary is missing ${missingSummary.join(", ")}`);
  const missingFile = fileMetrics.length ? FILE_KEYS.filter((key) => !(key in fileMetrics[0])) : [];
  if (missingFile.length) throw new MetricsEngineError(`engine file_metrics is missing ${missingFile.join(", ")}`);
  const missingFunction = functions.length ? FUNCTION_KEYS.filter((key) => !(key in functions[0])) : [];
  if (missingFunction.length) {
    throw new MetricsEngineError(`engine function metrics are missing ${missingFunction.join(", ")}`);
  }
  return {
    ...Object.fromEntries(SUMMARY_KEYS.map((key) => [key, summary[key]])),
    file_metrics: fileMetrics,
    most_complex_functions: functions.slice(0, 15),
    dependency_graph: payload.dependency_graph || {},
    scan_mode: scanMode,
    scan_root: resolved,
    engine: "tina4-cli",
  };
}

export function fileDetail(filePath: string): Record<string, any> {
  if (!filePath) throw new MetricsEngineError("fileDetail needs a path");
  let target = filePath;
  if (!fs.existsSync(target) && lastScanRoot) target = path.join(lastScanRoot, filePath);
  if (!fs.existsSync(target)) throw new MetricsEngineError(`no such file: ${filePath}`);
  if (fs.statSync(target).isDirectory()) throw new MetricsEngineError(`not a file: ${filePath}`);
  const payload = runEngine(target);
  const files = requireArray(payload, "file_metrics");
  if (!files.length) throw new MetricsEngineError(`engine reported no metrics for ${filePath}`);
  return {
    ...files[0],
    function_count: files[0].functions || 0,
    functions: requireArray(payload, "most_complex_functions"),
    engine: "tina4-cli",
  };
}
