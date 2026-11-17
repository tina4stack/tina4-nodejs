# Deployment Recipes (Node.js)

Node Tina4 apps deploy via Docker. The default listen port is **7148**.

## Base image (simplest)

`docker.io/tina4stack/tina4-nodejs` is the published base image (as `tina4stack/tina4-python`,
`tina4stack/tina4-php` and `tina4stack/tina4-ruby` are for the other frameworks): the Node runtime
plus the framework already built, with `TINA4_OVERRIDE_CLIENT=true` and `TINA4_DEBUG=false` set.
Inherit it and copy in only your code:

```dockerfile
FROM docker.io/tina4stack/tina4-nodejs:v3   # prefer an exact version tag; `v3` and `latest` move
RUN npm install pg                          # only if you use a non-SQLite driver (npm is on PATH)
COPY src/ /app/src/
```

## App Dockerfile (own multi-stage build)

This is the pattern `tina4nodejs init` scaffolds (with the deprecated `PORT`/`HOST` replaced by
`TINA4_PORT`/`TINA4_HOST`). `app.ts` must call `startServer()` (and `await initDatabase({ url })` for
non-SQLite):

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
ENV TINA4_HOST=0.0.0.0
ENV TINA4_PORT=7148
EXPOSE 7148
# tsx is a devDependency, so it is NOT installed after `npm ci --production` — serve with the CLI
CMD ["npx", "tina4nodejs", "serve", "--production"]
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

SQLite works out of the box (bundled with Node), and `npm install tina4-nodejs` adds exactly one
package. Other engines are **the app's dependencies** (ADR-0067) — tina4-nodejs never installs them.
Add the one you use to the project's `package.json` `dependencies` so `npm ci` installs it into the
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
| `TINA4_PORT` | Listen port (default 7148); bare `PORT` is the deprecated legacy name (still read, with a warning) |
| `TINA4_HOST` | Bind address (`0.0.0.0` in containers); bare `HOST` is the legacy name |
| `TINA4_SECRET` | JWT signing secret — **required** in production |
| `TINA4_DATABASE_URL` | Database connection string |
| `TINA4_DEBUG` | `false` in production (disables the debug overlay + dev admin) |
| `TINA4_SESSION_BACKEND` | `file` / `redis` / `valkey` / `mongodb` / `memcached` / `database` (aliases: `filesystem`, `mongo`, `memcache`, `db`) |

## Production Checklist

1. Inherit `tina4stack/tina4-nodejs`, or a multi-stage build from `node:22-alpine` with
   `npm ci --production` and `CMD ["npx", "tina4nodejs", "serve", "--production"]`.
2. Mount a volume for `/app/data` (SQLite database, sessions, queue, mailbox).
3. Set `TINA4_DEBUG=false`.
4. Pass `TINA4_SECRET` via environment (not committed `.env`).
5. `app.ts` calls `await initDatabase({ url })` for any non-SQLite engine before `startServer()`.
6. Health check hits `/health`.
7. Configure a Docker restart policy (`unless-stopped` or `always`).
8. Put a reverse proxy (nginx / Traefik) in front for SSL termination.
