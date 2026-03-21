# CLI

The Tina4 CLI (`tina4nodejs`, with `tina4` as alias) provides commands to scaffold new projects and run the development server.

## Installation

```bash
npm install -g tina4-nodejs
# or use npx
npx tina4nodejs init my-project
```

## Commands

### `tina4nodejs init [dir]`

Scaffolds a new Tina4 project with a complete directory structure and sample files.

```bash
# Create a new project in "my-project" directory
tina4nodejs init my-project

# Initialize in the current directory
tina4nodejs init .
```

#### What It Creates

```
my-project/
  src/
    routes/
      api/
        hello/
          get.ts          # Sample GET /api/hello route
    models/
      Example.ts          # Sample model with 5 fields
    templates/
      welcome.html.twig   # Sample Twig template
  public/
    index.html            # Static landing page
  data/                   # Database storage directory
  package.json            # Pre-configured with tina4 dependencies
  tsconfig.json           # TypeScript config (ES2022, Node16)
  .gitignore              # Ignores node_modules, dist, *.db, .env, data/
```

#### Generated package.json Scripts

```json
{
  "scripts": {
    "dev": "tina4 serve",
    "serve": "tina4 serve"
  }
}
```

After scaffolding, the CLI automatically runs `npm install`.

### `tina4nodejs serve`

Starts the development server with hot-reload. Watches `src/routes/`, `src/models/`, and `src/templates/` for changes.

```bash
tina4nodejs serve

# With custom port
tina4nodejs serve --port 8080
```

#### Server Output

```
  tina4 -- This is not a framework.

  Server running at http://localhost:7148
  Swagger docs at  http://localhost:7148/swagger

  Routes discovered:
    GET     /api/hello

  Models discovered:
    examples (5 fields)

  Auto-CRUD endpoints:
    GET     /api/examples
    GET     /api/examples/{id}
    POST    /api/examples
    PUT     /api/examples/{id}
    DELETE  /api/examples/{id}
```

### `tina4nodejs --help`

Displays usage information.

```
  tina4nodejs -- This is not a framework.

  Usage:
    tina4nodejs init [dir]    Create a new Tina4 project (default: current directory)
    tina4nodejs serve         Start the dev server with hot-reload

  Options:
    --port <number>      Server port (default: 7148)
    --help               Show this help message
```

## Running from Monorepo

If working within the tina4-nodejs monorepo itself:

```bash
# Using tsx directly
npx tsx packages/cli/src/bin.ts serve
npx tsx packages/cli/src/bin.ts init my-test
```

## Graceful Shutdown

The dev server handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully, closing the file watcher and database connections before exiting.
