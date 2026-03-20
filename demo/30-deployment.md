# Deployment

Tina4 runs with `tsx` in development and can be built to plain JavaScript with `esbuild` for production.

## Development

```bash
# Using the CLI
tina4nodejs serve

# Or npm scripts
npm run dev
```

Development mode uses `tsx` to run TypeScript directly with no build step.

## Production Build

The monorepo builds all packages with:

```bash
npm run build
```

This uses `esbuild` to compile TypeScript to JavaScript in each package's `dist/` directory.

For your own project, add a build step:

```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

Or use `esbuild` for a single-file bundle:

```json
{
  "scripts": {
    "build": "esbuild src/server.ts --bundle --platform=node --target=node20 --outfile=dist/server.js --format=esm --external:better-sqlite3 --external:twig",
    "start": "node dist/server.js"
  }
}
```

## Production Configuration

### Environment Variables

```bash
# .env.production
NODE_ENV=production
TINA4_ENV=production
PORT=8080

# Database
DATABASE_URL=sqlite:///data/production.db

# Security
TINA4_CORS_ORIGINS=https://myapp.com
TINA4_RATE_LIMIT=200
TINA4_RATE_WINDOW=60

# Logging
# In production, logs are JSON lines to logs/tina4.log (no console output)
```

### Programmatic Server Start

```typescript
// src/server.ts
import { startServer } from "@tina4/core";

await startServer({
  port: parseInt(process.env.PORT ?? "3000", 10),
  database: {
    type: "sqlite",
    path: process.env.DB_PATH ?? "./data/production.db",
  },
});
```

## Process Manager

Use PM2 or similar for production process management:

```bash
# Install PM2
npm install -g pm2

# Start with PM2
pm2 start dist/server.js --name "tina4-app"

# Or with tsx in development
pm2 start --interpreter tsx src/server.ts --name "tina4-dev"
```

### ecosystem.config.js

```javascript
module.exports = {
  apps: [{
    name: "tina4-app",
    script: "dist/server.js",
    instances: 1,
    env: {
      NODE_ENV: "production",
      PORT: 8080,
    },
  }],
};
```

## Docker

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p data logs

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/server.js"]
```

## Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name myapp.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Tina4's rate limiter and IP detection read `X-Forwarded-For`, so they work correctly behind a reverse proxy.

## Checklist

- [ ] Set `NODE_ENV=production` or `TINA4_ENV=production`
- [ ] Configure `TINA4_CORS_ORIGINS` to your domain(s) (not `*`)
- [ ] Set a strong `JWT_SECRET` if using auth
- [ ] Ensure `data/` directory is persistent (not ephemeral)
- [ ] Configure rate limiting appropriate for your traffic
- [ ] Set up log rotation or external log management
- [ ] Use a process manager (PM2, systemd, Docker) for restarts
- [ ] Place behind a reverse proxy for TLS termination

## Notes

- SQLite databases are single-file, so ensure the `data/` directory is on persistent storage.
- The `better-sqlite3` native module must be compiled for the target platform. Use `npm rebuild` if deploying to a different architecture.
- Static files in `public/` should be served by nginx/CDN in production for best performance.
