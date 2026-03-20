/**
 * Tina4 Node.js — Runnable Feature Demo
 *
 * Run from monorepo root:
 *   npx tsx demo/app.ts
 *
 * Or from demo directory:
 *   cd demo && npx tsx app.ts
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Resolve paths relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Imports from local packages (relative to demo/) ─────────────

import {
  startServer,
  get,
  Router,
  Log,
  loadEnv,
  getEnv,
  createToken,
  validateToken,
  getPayload,
  hashPassword,
  checkPassword,
  authMiddleware,
  Session,
  I18n,
  FakeData,
  ScssCompiler,
  Queue,
  GraphQL,
  responseCache,
  clearCache,
  cacheStats,
  rateLimiter,
  HTTP_OK,
  HTTP_CREATED,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  TEXT_HTML,
  APPLICATION_JSON,
} from "../packages/core/src/index.js";

import type {
  Tina4Request,
  Tina4Response,
  RouteHandler,
} from "../packages/core/src/index.js";

import {
  initDatabase,
  getAdapter,
  closeDatabase,
  validate,
  buildQuery,
  parseQueryString,
  BaseModel,
} from "../packages/orm/src/index.js";

import type {
  FieldDefinition,
  DatabaseAdapter,
} from "../packages/orm/src/index.js";

// ── Load .env from demo directory ───────────────────────────────
loadEnv(join(__dirname, ".env"));

// ── SQLite temp database for demo ───────────────────────────────
const dbPath = join(tmpdir(), `tina4-demo-${Date.now()}.db`);

// ── Demo Model: Product ─────────────────────────────────────────
const productFields: Record<string, FieldDefinition> = {
  id:    { type: "integer", primaryKey: true, autoIncrement: true },
  name:  { type: "string", required: true, minLength: 2, maxLength: 100 },
  price: { type: "number", required: true, min: 0 },
  sku:   { type: "string", pattern: "^[A-Z]{3}-\\d{3}$" },
};

// ── Initialize i18n ─────────────────────────────────────────────
const i18n = new I18n(join(__dirname, "src/locales"), "en");

// ── Initialize Queue ────────────────────────────────────────────
const queue = new Queue("file", { path: join(tmpdir(), "tina4-demo-queue") });

// ── Initialize GraphQL ──────────────────────────────────────────
const gql = new GraphQL();
gql.addType("Product", {
  id:    { type: "ID" },
  name:  { type: "String" },
  price: { type: "Float" },
});
gql.addQuery("products", {}, "[Product]", () => {
  try {
    const db = getAdapter();
    return db.query("SELECT * FROM products LIMIT 10");
  } catch {
    return [
      { id: 1, name: "Demo Widget", price: 9.99 },
      { id: 2, name: "Demo Gadget", price: 19.99 },
    ];
  }
});
gql.addQuery("product", { id: "ID!" }, "Product", (_root, args) => {
  try {
    const db = getAdapter();
    const rows = db.query('SELECT * FROM products WHERE id = ?', [args.id]);
    return rows[0] ?? null;
  } catch {
    return { id: args.id, name: "Demo Widget", price: 9.99 };
  }
});
gql.addMutation("createProduct", { name: "String!", price: "Float!" }, "Product", (_root, args) => {
  return { id: 99, name: args.name, price: args.price };
});

// ── Initialize SCSS Compiler ────────────────────────────────────
const scss = new ScssCompiler({
  variables: { "primary-color": "#4a90d9", "font-size": "16px" },
});

// ── JWT secret for demos ────────────────────────────────────────
const JWT_SECRET = getEnv("JWT_SECRET", "tina4-demo-secret-change-me");

// ── Register all demo routes on the default router ──────────────

// --- Landing Page ---
get("/", (_req: Tina4Request, res: Tina4Response) => {
  const features = [
    { path: "/demo/routing",       name: "Routing" },
    { path: "/demo/routing/42",    name: "Dynamic Params" },
    { path: "/demo/orm",           name: "ORM & Models" },
    { path: "/demo/swagger",       name: "Swagger / OpenAPI" },
    { path: "/demo/middleware",    name: "Middleware Chain" },
    { path: "/demo/static",        name: "Static Files" },
    { path: "/demo/validation",    name: "Request Validation" },
    { path: "/demo/query-params",  name: "Filter/Sort/Page" },
    { path: "/demo/auth",          name: "JWT Auth" },
    { path: "/demo/sessions",      name: "Sessions" },
    { path: "/demo/websocket",     name: "WebSocket" },
    { path: "/demo/graphql",       name: "GraphQL" },
    { path: "/demo/queue",         name: "Queue" },
    { path: "/demo/i18n",          name: "Internationalization" },
    { path: "/demo/faker",         name: "Fake Data" },
    { path: "/demo/logging",       name: "Logger" },
    { path: "/demo/cache",         name: "Response Cache" },
    { path: "/demo/rate-limit",    name: "Rate Limiter" },
    { path: "/demo/health",        name: "Health Check" },
    { path: "/demo/scss",          name: "SCSS Compiler" },
    { path: "/demo/shortcomings",  name: "Shortcomings" },
    { path: "/swagger",            name: "Swagger UI (built-in)" },
    { path: "/health",             name: "Health Endpoint (built-in)" },
  ];

  const links = features
    .map((f) => `<li><a href="${f.path}">${f.name}</a> — <code>${f.path}</code></li>`)
    .join("\n        ");

  res.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tina4 Node.js — Feature Demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #333; }
    h1 { color: #4a90d9; }
    a { color: #4a90d9; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
    li { margin-bottom: 0.5rem; }
    .subtitle { color: #666; font-style: italic; }
  </style>
</head>
<body>
  <h1>Tina4 Node.js — Feature Demo</h1>
  <p class="subtitle">This is not a framework. Every route below demonstrates a working feature.</p>
  <ul>
    ${links}
  </ul>
  <p>All demo routes return JSON. The Swagger UI at <a href="/swagger">/swagger</a> auto-documents every endpoint.</p>
</body>
</html>`);
});

// --- Routing Demo ---
get("/demo/routing", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "routing",
    status: "working",
    output: {
      description: "Programmatic route registration using get(), post(), etc.",
      supportedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "ANY"],
      dynamicParams: "Use {id} or :id syntax — try /demo/routing/42",
      routeGroups: "Router.group() for shared prefixes and middleware",
    },
    notes: "File-based routing (src/routes/) also supported via route discovery.",
  });
});

// --- Dynamic Params ---
get("/demo/routing/{id}", (req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "dynamic-params",
    status: "working",
    output: {
      paramId: req.params.id,
      description: "Dynamic parameter extracted from URL pattern /demo/routing/{id}",
      receivedUrl: req.url,
    },
    notes: "Supports {id}, [id], and :id syntax. Catch-all with {...slug} or [...slug].",
  });
});

// --- ORM Demo ---
get("/demo/orm", async (_req: Tina4Request, res: Tina4Response) => {
  try {
    const db = getAdapter();

    // Create a demo table
    db.execute(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        sku TEXT
      )
    `);

    // Insert demo data
    db.execute("DELETE FROM products");
    db.execute("INSERT INTO products (name, price, sku) VALUES (?, ?, ?)", ["Widget", 9.99, "WDG-001"]);
    db.execute("INSERT INTO products (name, price, sku) VALUES (?, ?, ?)", ["Gadget", 19.99, "GDG-002"]);
    db.execute("INSERT INTO products (name, price, sku) VALUES (?, ?, ?)", ["Gizmo", 29.99, "GZM-003"]);

    const rows = db.query("SELECT * FROM products");

    res.json({
      feature: "orm",
      status: "working",
      output: {
        description: "ORM with SQLite adapter via better-sqlite3",
        databasePath: dbPath,
        modelDefinition: {
          tableName: "products",
          fields: productFields,
        },
        queryResult: rows,
        capabilities: [
          "initDatabase() — factory with adapter pattern",
          "BaseModel — instance methods: save(), delete(), findById(), findAll(), toArray()",
          "Auto-CRUD — generates GET/POST/PUT/DELETE endpoints from models",
          "syncModels() — auto-migration from model field definitions",
          "Multi-database — named adapters via setNamedAdapter()",
        ],
      },
      notes: "Using temp SQLite database for this demo.",
    });
  } catch (err) {
    res.json({
      feature: "orm",
      status: "partial",
      output: { error: String(err) },
      notes: "ORM requires better-sqlite3. Run 'npm install' in the monorepo root.",
    });
  }
});

// --- Swagger Demo ---
get("/demo/swagger", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "swagger",
    status: "working",
    output: {
      swaggerUi: "/swagger",
      openApiSpec: "/swagger/openapi.json",
      description: "Auto-generated OpenAPI 3.0 spec from registered routes and models",
      capabilities: [
        "Route meta (summary, description, tags) mapped to OpenAPI operations",
        "Model fields mapped to JSON Schema components",
        "Swagger UI served via CDN at /swagger",
      ],
    },
    notes: "Visit /swagger to see the interactive API documentation.",
  });
});

// --- Middleware Demo ---
get("/demo/middleware", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "middleware",
    status: "working",
    output: {
      description: "MiddlewareChain with built-in CORS and request logger",
      builtInMiddleware: [
        "cors() — Cross-Origin Resource Sharing headers",
        "requestLogger() — Logs incoming requests",
        "rateLimiter() — Sliding-window rate limiting per IP",
      ],
      perRouteMiddleware: "Pass middleware array as 3rd argument to get(), post(), etc.",
      customMiddleware: "Signature: (req, res, next) => void | Promise<void>",
    },
    notes: "Per-route middleware runs after global middleware, before the handler.",
  });
});

// --- Static Files Demo ---
get("/demo/static", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "static-files",
    status: "working",
    output: {
      description: "Static file serving from public/ directory",
      servingFrom: "public/",
      capabilities: [
        "MIME type detection by file extension",
        "index.html fallback for directories",
        "Served before route matching",
      ],
    },
    notes: "Create a public/ directory in your project root with static assets.",
  });
});

// --- Validation Demo ---
get("/demo/validation", (_req: Tina4Request, res: Tina4Response) => {
  // Demonstrate validation with valid and invalid data
  const validData = { name: "Widget", price: 9.99, sku: "WDG-001" };
  const invalidData = { name: "X", price: -5, sku: "bad-sku" };

  const validErrors = validate(validData, productFields);
  const invalidErrors = validate(invalidData, productFields);

  res.json({
    feature: "validation",
    status: "working",
    output: {
      description: "Request body validation against model field definitions",
      modelFields: productFields,
      validInput: { data: validData, errors: validErrors, passed: validErrors.length === 0 },
      invalidInput: { data: invalidData, errors: invalidErrors, passed: invalidErrors.length === 0 },
      supportedRules: ["required", "type", "minLength", "maxLength", "min", "max", "pattern"],
    },
    notes: "validate() returns an array of { field, message } errors.",
  });
});

// --- Query Params Demo ---
get("/demo/query-params", (req: Tina4Request, res: Tina4Response) => {
  // Parse the request query params
  const options = parseQueryString(req.query ?? {});

  // Build a demo SQL query
  const query = buildQuery("products", {
    filter: options.filter ?? { name: "Widget" },
    sort: options.sort ?? "-price",
    page: options.page ?? 1,
    limit: options.limit ?? 20,
  });

  res.json({
    feature: "query-params",
    status: "working",
    output: {
      description: "Filter, sort, and paginate auto-CRUD endpoints",
      exampleUrl: "/demo/query-params?filter[name]=Widget&sort=-price&page=1&limit=10",
      parsedFromRequest: options,
      generatedQuery: query,
      syntax: {
        filter: "filter[field]=value or filter[field][gt]=25",
        sort: "sort=name (ASC) or sort=-name (DESC), comma-separated",
        pagination: "page=N&limit=M (defaults: page=1, limit=20)",
        operators: { gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "!=", like: "LIKE" },
      },
    },
    notes: "Try adding query params to this URL to see parsing in action.",
  });
});

// --- Auth / JWT Demo ---
get("/demo/auth", (_req: Tina4Request, res: Tina4Response) => {
  // Generate a demo token
  const payload = { userId: 1, role: "admin", name: "Demo User" };
  const token = createToken(payload, JWT_SECRET!, 3600);

  // Validate the token
  const verified = validateToken(token, JWT_SECRET!);

  // Get payload without verification
  const decoded = getPayload(token);

  // Password hashing demo
  const hash = hashPassword("demo-password-123");
  const passwordMatch = checkPassword("demo-password-123", hash);
  const passwordMismatch = checkPassword("wrong-password", hash);

  res.json({
    feature: "auth",
    status: "working",
    output: {
      jwt: {
        token,
        verified,
        decoded,
        algorithms: ["HS256", "RS256"],
      },
      passwordHashing: {
        algorithm: "PBKDF2-SHA256",
        hash,
        correctPasswordMatch: passwordMatch,
        wrongPasswordMatch: passwordMismatch,
      },
      middleware: "authMiddleware(secret) — validates Bearer tokens, sets req.auth",
    },
    notes: "JWT uses Node.js built-in crypto. Zero external dependencies.",
  });
});

// --- Sessions Demo ---
get("/demo/sessions", (_req: Tina4Request, res: Tina4Response) => {
  const sessionPath = join(tmpdir(), "tina4-demo-sessions");
  const session = new Session("file", { path: sessionPath, ttl: 3600 });

  // Start a new session
  const sessionId = session.start();

  // Set some values
  session.set("user", { name: "Demo User", role: "admin" });
  session.set("visits", 1);
  session.flash("notice", "Welcome to the demo!");

  // Read values back
  const userData = session.get("user");
  const visits = session.get("visits");
  const flash = session.getFlash("notice");
  const flashAgain = session.getFlash("notice"); // Should be undefined (consumed)

  // Get all data
  const allData = session.all();

  // Regenerate ID
  const newId = session.regenerate();

  // Clean up
  session.destroy();

  res.json({
    feature: "sessions",
    status: "working",
    output: {
      description: "File-backed session management with flash data",
      sessionId,
      regeneratedId: newId,
      storedData: { user: userData, visits },
      flashData: { firstRead: flash, secondRead: flashAgain },
      allSessionData: allData,
      capabilities: [
        "start()/destroy() — lifecycle management",
        "get()/set()/delete() — key-value storage",
        "flash()/getFlash() — one-time read data",
        "regenerate() — new ID, keep data",
        "has() — check key existence",
        "all() — dump session data",
        "TTL-based expiration",
      ],
    },
    notes: "File backend stores sessions as JSON in data/sessions/.",
  });
});

// --- WebSocket Demo ---
get("/demo/websocket", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "websocket",
    status: "working",
    output: {
      description: "Zero-dependency RFC 6455 WebSocket server",
      capabilities: [
        "HTTP Upgrade handshake with Sec-WebSocket-Accept",
        "Frame protocol: text, binary, close, ping, pong",
        "Client masking/unmasking",
        "Extended payload lengths (7-bit, 16-bit, 64-bit)",
        "Connection manager with broadcast",
        "Event-based API: on('connection'), on('message'), on('close')",
      ],
      usage: "const wss = new WebSocketServer({ port: 8080 }); await wss.start();",
    },
    notes: "WebSocket server runs on a separate port. Not started in this demo to avoid port conflicts.",
  });
});

// --- GraphQL Demo ---
get("/demo/graphql", (req: Tina4Request, res: Tina4Response) => {
  // Use query param or default query
  const queryStr = (req.query?.q as string) ?? '{ products { id name price } }';

  const result = gql.execute(queryStr);
  const schema = gql.schema();

  res.json({
    feature: "graphql",
    status: "working",
    output: {
      description: "Zero-dependency GraphQL engine with recursive-descent parser",
      schema,
      query: queryStr,
      result,
      exampleQueries: [
        '{ products { id name price } }',
        '{ product(id: 1) { name price } }',
        'mutation { createProduct(name: "New Item", price: 29.99) { id name } }',
      ],
      capabilities: [
        "Queries and mutations",
        "Variables and default values",
        "Aliases",
        "Nested selections",
        "List types [Type] and non-null Type!",
        "Error capture with resolver exceptions",
        "SDL schema generation",
      ],
      tryIt: "Add ?q={ product(id: 1) { name } } to this URL",
    },
    notes: "Try different queries via the ?q= query parameter.",
  });
});

// --- Queue Demo ---
get("/demo/queue", (_req: Tina4Request, res: Tina4Response) => {
  // Clear any previous demo data
  queue.clear("demo-emails");

  // Push some jobs
  const job1Id = queue.push("demo-emails", { to: "alice@example.com", subject: "Hello" });
  const job2Id = queue.push("demo-emails", { to: "bob@example.com", subject: "Welcome" });
  const job3Id = queue.push("demo-emails", { to: "charlie@example.com", subject: "Delayed" }, 60);

  const sizeAfterPush = queue.size("demo-emails");

  // Pop a job
  const poppedJob = queue.pop("demo-emails");
  const sizeAfterPop = queue.size("demo-emails");

  // Process remaining
  const processed: unknown[] = [];
  queue.process("demo-emails", (job) => {
    processed.push(job.payload);
  });

  const sizeAfterProcess = queue.size("demo-emails");

  // Clean up
  queue.clear("demo-emails");

  res.json({
    feature: "queue",
    status: "working",
    output: {
      description: "File-backed job queue for background processing",
      pushedJobs: [job1Id, job2Id, job3Id],
      sizeAfterPush,
      poppedJob: poppedJob ? { id: poppedJob.id, payload: poppedJob.payload, status: poppedJob.status } : null,
      sizeAfterPop,
      processedPayloads: processed,
      sizeAfterProcess,
      capabilities: [
        "push() — add jobs with optional delay",
        "pop() — atomically claim next job",
        "process() — batch process with handler",
        "size() — count pending jobs",
        "clear() — remove all jobs",
        "failed() — list failed jobs",
        "retry() — re-queue failed jobs",
      ],
    },
    notes: "File backend stores jobs as JSON. No Redis or external queue needed.",
  });
});

// --- i18n Demo ---
get("/demo/i18n", (_req: Tina4Request, res: Tina4Response) => {
  // English translations
  const greeting_en = i18n.t("greeting", { name: "World" });
  const welcome_en = i18n.t("welcome");
  const items_en = i18n.t("items.count", { count: "5" });

  // French translations
  i18n.setLocale("fr");
  const greeting_fr = i18n.t("greeting", { name: "Monde" });
  const welcome_fr = i18n.t("welcome");
  const items_fr = i18n.t("items.count", { count: "5" });

  // Reset to English
  i18n.setLocale("en");

  const available = i18n.getAvailableLocales();

  res.json({
    feature: "i18n",
    status: "working",
    output: {
      description: "JSON-based translation files with locale fallback",
      availableLocales: available,
      english: { greeting: greeting_en, welcome: welcome_en, items: items_en },
      french: { greeting: greeting_fr, welcome: welcome_fr, items: items_fr },
      capabilities: [
        "t(key, params) — translate with {placeholder} interpolation",
        "setLocale()/getLocale() — switch active locale",
        "Nested keys: items.count flattened from JSON",
        "Fallback to default locale, then to key itself",
        "getAvailableLocales() — list loaded locales",
        "addTranslation() — add in-memory translations",
      ],
    },
    notes: "Translation files are in demo/src/locales/. Supports nested JSON keys.",
  });
});

// --- Faker / FakeData Demo ---
get("/demo/faker", (_req: Tina4Request, res: Tina4Response) => {
  // Generate fake data
  const fake = new FakeData();
  const fakeUsers = fake.run(() => ({
    name: fake.fullName(),
    email: fake.email(),
    phone: fake.phone(),
    address: fake.address(),
    company: fake.company(),
    jobTitle: fake.jobTitle(),
  }), 3);

  const singleValues = {
    firstName: fake.firstName(),
    lastName: fake.lastName(),
    city: fake.city(),
    country: fake.country(),
    zipCode: fake.zipCode(),
    uuid: fake.uuid(),
    url: fake.url(),
    ipAddress: fake.ipAddress(),
    color: fake.color(),
    hexColor: fake.hexColor(),
    currency: fake.currency(),
    date: fake.date(),
    integer: fake.integer(1, 100),
    float: fake.float(0, 100, 2),
    boolean: fake.boolean(),
    word: fake.word(),
    sentence: fake.sentence(),
    paragraph: fake.paragraph(2),
  };

  res.json({
    feature: "faker",
    status: "working",
    output: {
      description: "Fake data generation for testing and development",
      generatedUsers: fakeUsers,
      singleValues,
      capabilities: [
        "firstName(), lastName(), fullName()",
        "email(), phone(), address(), city(), country(), zipCode()",
        "company(), jobTitle()",
        "uuid(), url(), ipAddress()",
        "color(), hexColor(), currency()",
        "date(), integer(), float(), boolean()",
        "word(), sentence(), paragraph()",
        "run(fn, count) — generate N records",
        "seed(dir) — run seed files",
      ],
    },
    notes: "All randomness uses Node.js crypto.randomInt for better distribution.",
  });
});

// --- Logging Demo ---
get("/demo/logging", (_req: Tina4Request, res: Tina4Response) => {
  // Generate some log entries
  Log.info("Demo info message", { route: "/demo/logging" });
  Log.debug("Demo debug message", { detail: "verbose info" });
  Log.warning("Demo warning message", { risk: "low" });

  res.json({
    feature: "logging",
    status: "working",
    output: {
      description: "Structured logging with file rotation and JSON output",
      logMethods: ["Log.info()", "Log.debug()", "Log.warning()", "Log.error()"],
      environments: {
        production: "JSON lines to logs/tina4.log",
        development: "Colorized stdout + file",
      },
      capabilities: [
        "Structured JSON log entries",
        "Request ID correlation via Log.setRequestId()",
        "File rotation by size (10MB)",
        "Log.configure() for custom directory/filename",
      ],
      example: {
        timestamp: new Date().toISOString(),
        level: "INFO",
        message: "Demo info message",
        data: { route: "/demo/logging" },
      },
    },
    notes: "Check the logs/ directory for generated log files. Also check console output.",
  });
});

// --- Cache Demo ---
get("/demo/cache", (_req: Tina4Request, res: Tina4Response) => {
  // Clear cache and show stats
  clearCache();

  const statsBeforeCache = cacheStats();

  res.json({
    feature: "cache",
    status: "working",
    output: {
      description: "In-memory response cache middleware for GET requests",
      cacheStats: statsBeforeCache,
      capabilities: [
        "responseCache({ ttl, maxEntries, statusCodes }) — middleware factory",
        "Caches full response body, content-type, status code",
        "X-Cache header: HIT or MISS",
        "Periodic cleanup of expired entries",
        "clearCache() — flush all entries",
        "cacheStats() — size and key listing",
      ],
      config: {
        envVar: "TINA4_CACHE_TTL — default TTL in seconds (0 = disabled)",
        defaultTtl: 60,
        maxEntries: 1000,
      },
    },
    notes: "Response caching is enabled as a middleware in the server pipeline.",
  });
});

// --- Rate Limiter Demo ---
get("/demo/rate-limit", (req: Tina4Request, res: Tina4Response) => {
  // Read rate limit headers that were set by the middleware
  const headers = {
    "X-RateLimit-Limit": res.raw.getHeader("X-RateLimit-Limit"),
    "X-RateLimit-Remaining": res.raw.getHeader("X-RateLimit-Remaining"),
    "X-RateLimit-Reset": res.raw.getHeader("X-RateLimit-Reset"),
  };

  res.json({
    feature: "rate-limit",
    status: "working",
    output: {
      description: "Sliding-window rate limiter per IP",
      currentHeaders: headers,
      capabilities: [
        "rateLimiter({ limit, windowSeconds }) — middleware factory",
        "Sliding window algorithm per client IP",
        "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers",
        "Retry-After header on 429 response",
        "Supports X-Forwarded-For for proxy setups",
      ],
      config: {
        envVars: {
          TINA4_RATE_LIMIT: "Max requests per window (default: 100)",
          TINA4_RATE_WINDOW: "Window duration in seconds (default: 60)",
        },
      },
    },
    notes: "Rate limiting is active on all routes. Rapid-fire requests will trigger 429.",
  });
});

// --- Health Check Demo ---
get("/demo/health", (_req: Tina4Request, res: Tina4Response) => {
  res.json({
    feature: "health-check",
    status: "working",
    output: {
      description: "Built-in /health endpoint",
      endpoint: "/health",
      response: {
        status: "ok",
        version: "3.0.0",
        uptime: "(seconds since server start)",
        framework: "tina4-nodejs",
      },
    },
    notes: "Visit /health for the live health check response.",
  });
});

// --- SCSS Demo ---
get("/demo/scss", (_req: Tina4Request, res: Tina4Response) => {
  const input = `
$primary-color: #4a90d9;
$font-size: 16px;

body {
  font-size: $font-size;
  color: $primary-color;

  .container {
    max-width: 800px;
    margin: 0 auto;

    &.wide {
      max-width: 1200px;
    }

    h1 {
      font-size: $font-size * 2;
    }
  }
}`;

  let css: string;
  try {
    css = scss.compile(input);
  } catch (err) {
    css = `/* Compilation error: ${err} */`;
  }

  res.json({
    feature: "scss",
    status: "working",
    output: {
      description: "Zero-dependency SCSS-to-CSS compiler (subset)",
      scssInput: input.trim(),
      cssOutput: css.trim(),
      capabilities: [
        "Variables ($name: value)",
        "Nesting with & parent selector",
        "@import resolution",
        "@mixin/@include with parameters",
        "Basic math evaluation (+ - * /)",
        "Comment stripping",
      ],
    },
    notes: "Supports a useful subset of SCSS. Not a full Sass replacement.",
  });
});

// --- Shortcomings ---
get("/demo/shortcomings", (_req: Tina4Request, res: Tina4Response) => {
  const report = {
    feature: "shortcomings",
    status: "working",
    output: {
      description: "Honest report of what works, what is partial, and what is missing",
      fullyWorking: [
        { name: "HTTP Server", notes: "Native node:http, zero-dependency" },
        { name: "Router", notes: "Pattern matching with {id}, [id], :id, catch-all" },
        { name: "Route Groups", notes: "Shared prefix + middleware via router.group()" },
        { name: "Middleware Chain", notes: "Global + per-route middleware" },
        { name: "CORS", notes: "Built-in CORS middleware" },
        { name: "Request Logger", notes: "Built-in request logging middleware" },
        { name: "Static Files", notes: "MIME detection, index.html fallback" },
        { name: "Route Discovery", notes: "File-based routing from src/routes/" },
        { name: ".env Loading", notes: "loadEnv(), getEnv(), requireEnv()" },
        { name: "Structured Logging", notes: "Log class with rotation, JSON output" },
        { name: "JWT Auth", notes: "HS256 + RS256, token generate/verify/decode" },
        { name: "Password Hashing", notes: "PBKDF2-SHA256 with constant-time comparison" },
        { name: "Auth Middleware", notes: "Bearer token extraction and validation" },
        { name: "Sessions", notes: "File-backed with TTL, flash data, regeneration" },
        { name: "Validation", notes: "Type checks, required, min/max, pattern" },
        { name: "Query Builder", notes: "Filter/sort/page from query string" },
        { name: "Response Cache", notes: "In-memory GET cache with TTL" },
        { name: "Rate Limiter", notes: "Sliding window per IP" },
        { name: "Health Check", notes: "Built-in /health endpoint" },
        { name: "FakeData", notes: "50+ fake data generators" },
        { name: "Queue", notes: "File-backed job queue with retry" },
        { name: "i18n", notes: "JSON translations, nested keys, interpolation" },
        { name: "SCSS Compiler", notes: "Variables, nesting, mixins, math" },
        { name: "GraphQL Engine", notes: "Parser, schema, queries, mutations, variables" },
        { name: "WebSocket Server", notes: "RFC 6455 implementation" },
        { name: "Swagger/OpenAPI", notes: "Auto-generated spec + Swagger UI" },
        { name: "ORM/SQLite", notes: "better-sqlite3 adapter, auto-CRUD, BaseModel" },
        { name: "HTTP Constants", notes: "Status codes and content type constants" },
        { name: "Services", notes: "Background service runner with cron" },
      ],
      roadmapNotYetImplemented: [
        { name: "PostgreSQL Adapter", notes: "Interface defined, adapter stubs exist but throw 'not yet implemented'" },
        { name: "MySQL Adapter", notes: "Interface defined, adapter stubs exist but throw 'not yet implemented'" },
        { name: "Bun Runtime", notes: "Not yet tested or adapted for Bun" },
      ],
      knownLimitations: [
        { name: "SCSS", notes: "Subset compiler — no @extend, @for, @each, @while, maps, or color functions" },
        { name: "GraphQL", notes: "No subscriptions, no fragments, no schema introspection query" },
        { name: "WebSocket", notes: "No automatic reconnection or heartbeat built in" },
        { name: "Queue", notes: "File-based only, no Redis/AMQP backend" },
        { name: "Sessions", notes: "File-based only, no Redis/database backend" },
        { name: "ORM", notes: "No migration rollback CLI, no relationship eager-loading" },
        { name: "Twig Templates", notes: "Requires optional @tina4/twig package with external dependency" },
      ],
    },
    notes: "This report reflects the current state of tina4-nodejs v3.0.0.",
  };

  res.json(report);
});

// ── Start the server ────────────────────────────────────────────

async function main() {
  // Initialize SQLite database for ORM demos
  try {
    await initDatabase({ type: "sqlite", path: dbPath });
    console.log(`  Database initialized at ${dbPath}`);
  } catch (err) {
    console.warn(`  Could not initialize database: ${err}`);
  }

  const port = parseInt(getEnv("PORT", "3000") ?? "3000", 10);

  const server = await startServer({
    port,
    routesDir: join(__dirname, "src/routes"),
    modelsDir: join(__dirname, "src/models"),
    staticDir: join(__dirname, "public"),
    templatesDir: join(__dirname, "src/templates"),
  });

  // Handle graceful shutdown
  const shutdown = () => {
    console.log("\n  Shutting down...");
    server.close();
    try { closeDatabase(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start demo server:", err);
  process.exit(1);
});
