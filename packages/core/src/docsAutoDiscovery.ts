/**
 * Live Docs MCP discovery — writes `.tina4/mcp.json` so MCP-aware AI tools
 * (Claude Code, Cursor, etc.) auto-discover this server's docs MCP endpoint.
 *
 * Idempotent — only writes if content has changed.
 *
 * Spec: plan/v3/22-LIVE-API-RAG.md (Auto-discovery section)
 */
import * as fs from "node:fs";
import * as path from "node:path";

interface McpDiscovery {
  mcpServers: Record<string, { url: string; description: string }>;
}

const TINA4_DIR = ".tina4";
const MCP_FILE = "mcp.json";
const GITIGNORE_LINE = ".tina4/";

/**
 * Write `.tina4/mcp.json` and (if `.git/` exists) append `.tina4/` to .gitignore.
 *
 * Returns true if the discovery file was written or updated.
 */
export function writeMcpDiscovery(projectRoot: string, port: number): boolean {
  const root = path.resolve(projectRoot);
  const tinaDir = path.join(root, TINA4_DIR);
  const mcpPath = path.join(tinaDir, MCP_FILE);

  const portStr = String(
    port || Number(process.env.TINA4_PORT) || Number(process.env.PORT) || 7148,
  );

  const desired: McpDiscovery = {
    mcpServers: {
      "tina4-live-docs": {
        url: `http://localhost:${portStr}/__dev/api/mcp`,
        description: "Live API docs for this Tina4 project (framework + user code)",
      },
    },
  };

  // Idempotent write — compare before overwriting.
  let existing: string | null = null;
  if (fs.existsSync(mcpPath)) {
    try { existing = fs.readFileSync(mcpPath, "utf-8"); } catch { /* fall through */ }
  }
  const desiredJson = JSON.stringify(desired, null, 2) + "\n";
  let wrote = false;
  if (existing !== desiredJson) {
    fs.mkdirSync(tinaDir, { recursive: true });
    fs.writeFileSync(mcpPath, desiredJson, "utf-8");
    wrote = true;
  }

  // Only append .gitignore entry inside a real git repo.
  const gitDir = path.join(root, ".git");
  if (fs.existsSync(gitDir)) {
    const gitignorePath = path.join(root, ".gitignore");
    let contents = "";
    if (fs.existsSync(gitignorePath)) {
      try { contents = fs.readFileSync(gitignorePath, "utf-8"); } catch { /* leave empty */ }
    }
    const lines = contents.split(/\r?\n/);
    const already = lines.some((l) => l.trim() === GITIGNORE_LINE || l.trim() === ".tina4");
    if (!already) {
      const sep = contents.endsWith("\n") || contents === "" ? "" : "\n";
      fs.writeFileSync(gitignorePath, `${contents}${sep}${GITIGNORE_LINE}\n`, "utf-8");
    }
  }

  return wrote;
}
