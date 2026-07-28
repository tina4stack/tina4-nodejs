# ghcr.io/tina4stack/tina4-nodejs
#
# Base image for Tina4 Node apps: the Node runtime plus the framework already
# built, so a developer injects only their own src/.
#
#   FROM ghcr.io/tina4stack/tina4-nodejs:3.13.92
#   COPY src/ /app/src/
#
# ---------------------------------------------------------------------------
# THIS FILE USED TO SHIP A TRANSPILER TO PRODUCTION. The old recipe was
# `npm ci --production` + `CMD ["npx", "tsx", "app.ts"]`, which is wrong three
# times over:
#
#   * tsx is a devDependency, so `--production` strips it -- and then npx
#     FETCHES IT OVER THE NETWORK at container start (observed running out of
#     /root/.npm/_npx/...). An air-gapped host or a registry outage means the
#     container never starts at all.
#   * measured, that was FIVE processes (npm exec -> tsx -> node -> esbuild
#     service) against ONE for PHP, Python and Ruby.
#   * node:22 while the package declares engines.node >=22 and imports
#     `node:sqlite`, which is still flagged experimental on 22 and prints a
#     warning into every production log. 24 is the floor worth shipping.
#
# It now compiles ahead of time and runs plain `node`. No transpiler, no npx, no
# network at start.
# ---------------------------------------------------------------------------

FROM node:24-alpine AS build
WORKDIR /build

# Framework first: dependencies resolve from the manifests alone, so this layer
# stays cached across source edits.
COPY package.json package-lock.json* tsconfig.json tsconfig.types.json ./
COPY packages/ packages/
RUN npm ci
RUN npm run build

# The bundled demo app, compiled to plain JS.
#
# Passing the files explicitly (rather than a tsconfig) makes tsc infer the
# common root as example/, so the output MIRRORS the source layout:
# dist/app.js next to dist/src/routes/*.js. That layout is the whole point --
# see the runtime stage.
#
# --noCheck emits without type-checking. An image build's job is to produce
# runnable JS, not to re-validate types; `npm run build` type-checks in
# development, where that belongs.
COPY example/ example/
RUN cd example && npx tsc app.ts $(find src -name '*.ts') \
      --outDir dist --rootDir . \
      --module nodenext --moduleResolution nodenext --target es2022 \
      --noCheck --skipLibCheck

# Prune dev dependencies AFTER compiling -- typescript is needed above.
RUN npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app

# Framework + its production dependencies. node_modules carries the workspace
# symlinks into packages/, so both have to land at the same relative depth for
# `import "@tina4/core"` to resolve.
COPY --from=build /build/node_modules /app/node_modules
COPY --from=build /build/packages /app/packages
COPY --from=build /build/package.json /app/
COPY --from=build /build/types /app/types

# The compiled demo, FLATTENED onto /app: dist/app.js becomes /app/app.js and
# dist/src/ becomes /app/src/. This is deliberate and load-bearing.
#
# Route discovery resolves its directory from process.cwd() (server.ts: `base =
# config?.basePath ? resolve(config.basePath) : process.cwd()`), and it accepts
# BOTH .ts and .js (routeDiscovery.ts: `if (ext !== ".ts" && ext !== ".js")`).
# So leaving the compiled routes under dist/ while the .ts originals sat at
# src/routes/ would have discovery import TypeScript under plain node --
# ERR_UNKNOWN_FILE_EXTENSION. Shipping BOTH is worse: a directory holding both
# get.ts and get.js registers the route twice.
#
# Flattening gives exactly one copy of each route, as .js, exactly where
# discovery looks. No .ts reaches this image.
COPY --from=build /build/example/dist/ /app/

EXPOSE 7148
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7148 \
    TINA4_OVERRIDE_CLIENT=true \
    TINA4_DEBUG=false

# Plain node on compiled JS. One process.
CMD ["node", "app.js"]
