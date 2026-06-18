import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

export async function initProject(name: string): Promise<void> {
  const targetDir = name === "." ? process.cwd() : resolve(name);
  const projectName = name === "." ? basename(process.cwd()) : basename(name);

  if (name !== "." && existsSync(targetDir)) {
    console.error(`Error: Directory "${targetDir}" already exists.`);
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

  // Copy framework public assets into the project so they're visible
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const frameworkPublic = resolve(__dirname, "..", "..", "..", "core", "public");
  const projectPublic = join(targetDir, "public");
  const assetsToCopy = [
    "css/tina4.css",
    "css/tina4.min.css",
    "js/tina4.min.js",
    "js/frond.min.js",
    "images/tina4-logo-icon.webp",
  ];
  for (const asset of assetsToCopy) {
    const src = join(frameworkPublic, ...asset.split("/"));
    const dst = join(projectPublic, ...asset.split("/"));
    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(src) && !existsSync(dst)) {
      copyFileSync(src, dst);
      console.log(`  Copied ${asset}`);
    }
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
          dev: "npx tina4nodejs serve",
          serve: "npx tina4nodejs serve",
        },
        dependencies: {
          "tina4-nodejs": "^3.0.0",
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
.env.local
.DS_Store
data/
`
  );

  // Dockerfile
  if (!existsSync(join(targetDir, "Dockerfile"))) {
    writeFileSync(
      join(targetDir, "Dockerfile"),
      `# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Runtime stage
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app .
ENV HOST=0.0.0.0
ENV PORT=7148
EXPOSE 7148
CMD ["npx", "tsx", "app.ts"]
`
    );
  }

  // .dockerignore
  if (!existsSync(join(targetDir, ".dockerignore"))) {
    writeFileSync(
      join(targetDir, ".dockerignore"),
      `node_modules
dist
.git
.claude
.env
*.log
test
tmp
`
    );
  }

  // Sample route: GET /api/hello
  writeFileSync(
    join(targetDir, "src/routes/api/hello/get.ts"),
    `import type { Tina4Request, Tina4Response } from "tina4-nodejs";

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
  <p>The Intelligent Native Application 4ramework</p>
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
  <p><em>The Intelligent Native Application 4ramework</em></p>
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

  let npmOk = true;
  try {
    execSync("npm install", { cwd: targetDir, stdio: "inherit" });
  } catch {
    npmOk = false;
    console.log("\n  Note: npm install failed — the package may not be published yet.");
    console.log("  Your project files have been created. You can install dependencies later.\n");
  }

  const absPath = resolve(targetDir);
  const cdStep = name === "." ? "" : `    cd ${absPath}\n`;
  console.log(`
  Done! Your Tina4 project is ready.

  Next steps:
${cdStep}    npm install
    npx tina4nodejs serve

  Your API will be running at http://localhost:7148
  Swagger docs at http://localhost:7148/swagger
`);
}
