/**
 * CLI command: build — build the deployable Docker image for this Tina4 app.
 *
 * A Tina4 app deploys as a container — `tina4nodejs init` and `tina4 deploy
 * docker` both scaffold a Dockerfile — so `build` produces THAT artifact: the
 * image. It shells out to the `docker` CLI (no new npm dependency) and fails
 * loud with guidance when there is no Dockerfile or docker is not on PATH,
 * instead of silently packaging the framework as a library.
 *
 *   tina4nodejs build                       # docker build -t <dir>:latest .
 *   tina4nodejs build --tag myapp:1.2        # explicit image tag
 *   tina4nodejs build --file docker/Dockerfile
 *
 * Mirrors the Python master's _build (tina4_python/cli/__init__.py).
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

/** Parse --key value / bare --flag (build only needs --tag and --file values). */
function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return flags;
}

/**
 * Resolve `docker` on PATH, or null when it is genuinely absent.
 *
 * Scans PATH directly (zero-dep, cross-platform) rather than shelling out, so a
 * deliberately emptied PATH really yields null — mirroring Python's
 * shutil.which("docker"), which the fail-loud guard relies on.
 */
function whichDocker(): string | null {
  const pathValue = process.env.PATH || process.env.Path || "";
  if (!pathValue) return null;
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `docker${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here / not executable — keep looking
      }
    }
  }
  return null;
}

/** Build the deployable Docker image. Fails loud (exit 1+) on missing prerequisites. */
export function buildImage(args: string[]): void {
  const flags = parseFlags(args);

  let tag = typeof flags.tag === "string" ? flags.tag : "";
  if (!tag) {
    // Default tag: <project-folder>:latest, lower-cased (docker repo names must
    // be lowercase). Fall back to a sane name for an unnamed cwd.
    const dirName = basename(process.cwd()).toLowerCase();
    tag = `${dirName || "tina4app"}:latest`;
  }

  const dockerfile = typeof flags.file === "string" && flags.file ? flags.file : "Dockerfile";
  if (!existsSync(dockerfile) || !statSync(dockerfile).isFile()) {
    console.log(`  ✗ No ${dockerfile} found.`);
    console.log("  A Tina4 app deploys as a container. Scaffold a Dockerfile first:");
    console.log("      tina4 deploy docker        (or: tina4nodejs init)");
    process.exit(1);
  }

  const docker = whichDocker();
  if (!docker) {
    console.log("  ✗ docker was not found on PATH.");
    console.log("  Install Docker to build the deployable image, or build manually:");
    console.log(`      docker build -t ${tag} -f ${dockerfile} .`);
    process.exit(1);
  }

  console.log(`  Building image ${tag} from ${dockerfile} ...`);
  const result = spawnSync(docker, ["build", "-t", tag, "-f", dockerfile, "."], {
    stdio: "inherit",
  });
  const code = result.status ?? 1;
  if (code !== 0) {
    console.log(`  ✗ docker build failed (exit ${code})`);
    process.exit(code);
  }
  console.log(`  ✓ Built image ${tag}`);
  console.log(`  Run: docker run -p 7148:7148 ${tag}`);
}
