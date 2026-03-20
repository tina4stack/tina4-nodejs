import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execSync } from "node:child_process";

export async function initProject(name: string): Promise<void> {
  const targetDir = name === "." ? process.cwd() : join(process.cwd(), name);
  const projectName = name === "." ? basename(process.cwd()) : name;

  if (name !== "." && existsSync(targetDir)) {
    console.error(`Error: Directory "${name}" already exists.`);
    process.exit(1);
  }

  console.log(`\n  Creating Tina4 project: ${projectName}\n`);

  // Create directory structure
  const dirs = [
    "",
    "src",
    "src/routes",
    "src/routes/api",
    "src/routes/api/hello",
    "src/models",
    "src/templates",
    "public",
    "data",
  ];

  for (const dir of dirs) {
    mkdirSync(join(targetDir, dir), { recursive: true });
  }

  // package.json
  writeFileSync(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: projectName,
        version: "0.0.1",
        private: true,
        type: "module",
        scripts: {
          dev: "tina4 serve",
          serve: "tina4 serve",
        },
        dependencies: {
          tina4: "^0.0.1",
          "@tina4/core": "^0.0.1",
          "@tina4/orm": "^0.0.1",
          "@tina4/swagger": "^0.0.1",
        },
        devDependencies: {
          typescript: "^5.7.0",
          tsx: "^4.19.0",
        },
      },
      null,
      2
    ) + "\n"
  );

  // tsconfig.json
  writeFileSync(
    join(targetDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "./dist",
          rootDir: "./src",
        },
        include: ["src"],
      },
      null,
      2
    ) + "\n"
  );

  // .gitignore
  writeFileSync(
    join(targetDir, ".gitignore"),
    `node_modules/
dist/
*.db
*.sqlite
.env
.DS_Store
data/
`
  );

  // Sample route: GET /api/hello
  writeFileSync(
    join(targetDir, "src/routes/api/hello/get.ts"),
    `import type { Tina4Request, Tina4Response } from "@tina4/core";

export const meta = {
  summary: "Hello World",
  tags: ["Example"],
};

export default async function (req: Tina4Request, res: Tina4Response): Promise<void> {
  res.json({ message: "Hello from Tina4!", timestamp: new Date().toISOString() });
}
`
  );

  // Sample model: Example
  writeFileSync(
    join(targetDir, "src/models/Example.ts"),
    `export default class Example {
  static tableName = "examples";

  static fields = {
    id: { type: "integer" as const, primaryKey: true, autoIncrement: true },
    name: { type: "string" as const, required: true, maxLength: 255 },
    description: { type: "text" as const },
    active: { type: "boolean" as const, default: true },
    createdAt: { type: "datetime" as const, default: "now" },
  };
}
`
  );

  // Sample template
  writeFileSync(
    join(targetDir, "src/templates/welcome.html.twig"),
    `<!DOCTYPE html>
<html>
<head>
  <title>{{ title }}</title>
</head>
<body>
  <h1>Welcome to {{ name }}</h1>
  <p>This is not a framework.</p>
</body>
</html>
`
  );

  // Static index page
  writeFileSync(
    join(targetDir, "public/index.html"),
    `<!DOCTYPE html>
<html>
<head>
  <title>Tina4</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 2.5em; margin-bottom: 0.2em; }
    p { color: #666; font-size: 1.1em; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>tina4</h1>
  <p><em>This is not a framework.</em></p>
  <p>Your API is running. Try:</p>
  <ul>
    <li><a href="/api/hello">GET /api/hello</a></li>
    <li><a href="/swagger">API Documentation</a></li>
  </ul>
</body>
</html>
`
  );

  console.log("  Installing dependencies...\n");

  try {
    execSync("npm install", { cwd: targetDir, stdio: "inherit" });
  } catch {
    console.log("\n  Note: npm install failed. Run it manually after setting up the tina4 packages.");
  }

  const cdStep = name === "." ? "" : `    cd ${name}\n`;
  console.log(`
  Done! Your Tina4 project is ready.

  Next steps:
${cdStep}    tina4nodejs serve

  Your API will be running at http://localhost:3000
  Swagger docs at http://localhost:3000/swagger
`);
}
