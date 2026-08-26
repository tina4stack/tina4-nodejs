# Deployment Recipes (Node.js)

Node Tina4 apps deploy via Docker built from the official **`node:22-alpine`** image using a
**multi-stage build**. There is **no** `tina4stack` base image for Node (unlike Python/PHP) — you
build directly from `node:22-alpine`. The default listen port is **7148**.

The container runs the app's own entry point (`app.ts`) with `tsx`, not `tina4nodejs serve` (the CLI
is for local dev). `app.ts` must call `startServer()` (and `await initDatabase({ url })` for non-SQLite).

## App Dockerfile

This is the exact pattern `tina4nodejs init` scaffolds:

```dockerfile
# Build stage
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
```

### .dockerignore

```
node_modules
dist
.git
.claude
.env
*.log
test
tmp
data
*.db
*.db-wal
*.db-shm
```

### Build and Run

```bash
docker build -t my-app .
docker run -d -p 7148:7148 -v $(pwd)/data:/app/data my-app
```

## Database Drivers

SQLite works out of the box (bundled with Node). Other engines are **optional peer dependencies** —
add the one you use to the project's `package.json` `dependencies` so `npm ci` installs it into the
image:

| Engine | npm package |
|--------|-------------|
| PostgreSQL | `pg` |
| MySQL / MariaDB | `mysql2` |
| MSSQL | `tedious` |
| Firebird | `node-firebird` |
| ODBC | `odbc` |
| MongoDB | `mongodb` |

```bash
npm install pg          # then rebuild the image; npm ci --production picks it up
```

No extra Alpine system packages are needed for these pure-JS drivers. For a non-SQLite engine, make
sure `app.ts` calls `await initDatabase({ url: process.env.TINA4_DATABASE_URL! })` before `startServer()`.

## Docker Compose

```yaml
services:
  app:
    build: .
    ports:
      - "7148:7148"
    environment:
      - TINA4_DEBUG=false
      - TINA4_SECRET=${TINA4_SECRET}
      - TINA4_DATABASE_URL=sqlite:data/app.db
    volumes:
      - app-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:7148/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  app-data:
```

## Environment Variables

Pass secrets at runtime — never bake them into the image:

```bash
docker run -d \
  -p 7148:7148 \
  -e TINA4_SECRET=your-secret \
  -e TINA4_DATABASE_URL=sqlite:data/app.db \
  -e TINA4_DEBUG=false \
  -v $(pwd)/data:/app/data \
  my-app
```

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default 7148) |
| `HOST` | Bind address (`0.0.0.0` in containers) |
| `TINA4_SECRET` | JWT signing secret — **required** in production |
| `TINA4_DATABASE_URL` | Database connection string |
| `TINA4_DEBUG` | `false` in production (disables the debug overlay + dev admin) |
| `TINA4_SESSION_BACKEND` | `file` / `redis` / `valkey` / `mongodb` / `memcached` / `database` (aliases: `filesystem`, `mongo`, `memcache`, `db`) |

## Production Checklist

1. Multi-stage build from `node:22-alpine`; `npm ci --production`.
2. Mount a volume for `/app/data` (SQLite database, sessions, queue, mailbox).
3. Set `TINA4_DEBUG=false`.
4. Pass `TINA4_SECRET` via environment (not committed `.env`).
5. `app.ts` calls `await initDatabase({ url })` for any non-SQLite engine before `startServer()`.
6. Health check hits `/health`.
7. Configure a Docker restart policy (`unless-stopped` or `always`).
8. Put a reverse proxy (nginx / Traefik) in front for SSL termination.
