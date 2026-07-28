# docker.io/tina4stack/tina4-nodejs
#
# Base image for Tina4 Node apps: the Node runtime plus the framework already
# built, so a developer injects only their own src/.
#
#   FROM docker.io/tina4stack/tina4-nodejs:3.13.92
#   COPY src/ /app/src/
#
# SQLITE ONLY, like the Python, PHP and Ruby images. The default database is
# node:sqlite, built into the Node runtime with zero dependencies. Add the driver
# you actually use:
#
#   FROM docker.io/tina4stack/tina4-nodejs:3.13.92
#   RUN npm install pg          # or mysql2, tedious, mongodb
#   COPY src/ /app/src/
#
# That ordinary `npm install` is only safe because of the /opt/tina4 layout below
# -- see the DE-WORKSPACE note. Shipping every driver instead cost 90 MB, most of
# it the Azure and AWS SDKs pulled in transitively by the MSSQL driver.
#
# THREE STEPS, in this order: inherit, get the tool you need, then modify. The
# same shape across all four Tina4 base images. Here there is NOTHING TO COPY IN:
# npm 11.16.0 is already on PATH, so adding a driver is one line. Verified:
# `npm install pg` builds, `pg` + `@tina4/core` + `@tina4/orm` all resolve,
# 185 MB derived.
#
# Python and PHP do NOT ship a working package manager and their headers document
# the one-line `COPY --from=` for uv / composer. Ruby, like Node, has gem built in.
#
# ON THIS IMAGE'S SIZE, because it invites the question: 174 MB, of which the
# `node` binary alone is 123 MB and npm is 19 MB. Tina4 contributes 9 MB, the
# smallest addition of the four images. node:24-alpine EMPTY is already 165 MB.
# Removing npm would save 24 MB and break the one-liner above, and shrinking the
# binary means compiling Node ourselves. Both rejected, with the measurements, in
# tina4-documentation/plan/v3/DECISIONS.md ADR-0007. Note that Docker Hub lists
# this image at 59 MB because Hub reports the COMPRESSED size; 174 MB is the
# on-disk figure from `du -sx /` inside the container.
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
#
# --omit=optional is the single biggest size lever in this file: it drops ~90 MB.
#
# packages/orm declares the DB drivers as optionalDependencies (mongodb, mysql2,
# pg, tedious) -- but npm installs optionalDependencies BY DEFAULT, so a plain
# `npm ci` pulled all four AND their transitive trees. tedious depends on
# @azure/identity, which drags in the entire Azure and AWS SDK surface:
#
#   @azure 42 MB + @aws-sdk 13 MB + @smithy 9 MB + @js-joda 8 MB
#   + @typespec 5 MB + mongodb 5 MB + @redis 5 MB + tedious 4 MB + bson 3 MB
#
# 61 of the 282 lockfile entries were driver-related, for an image whose default
# database is node:sqlite -- built into the Node runtime, zero dependencies.
#
# This matches what the Python, PHP and Ruby images already do: ship SQLite only
# and let the user add the driver they actually use. npm IS deliberately kept in
# the runtime stage so that `RUN npm install pg` works in a derived image.
COPY package.json package-lock.json* tsconfig.json tsconfig.types.json ./
COPY packages/ packages/
RUN npm ci --omit=optional
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
# --omit=optional again, because prune re-reads the manifests and would otherwise
# treat the optional drivers as wanted and reinstate them.
RUN npm prune --omit=dev --omit=optional

# The framework runs from dist/ (each package's exports map points at
# ./dist/index.js), so the TypeScript sources are dead weight in the runtime.
# Dropped here rather than in the runtime stage so the bytes never enter a layer.
RUN rm -rf packages/*/src packages/*/tsconfig*.json

# DE-WORKSPACE the tree before it ships. This is not tidying -- it is what makes
# the image extensible.
#
# In the monorepo, node_modules/@tina4/* are SYMLINKS into ../../packages/*, and
# /app/package.json declares `workspaces`. That makes /app a workspace ROOT, so
# any npm operation a user runs in a derived image re-resolves the entire
# monorepo: `RUN npm install pg` on the base produced a 495 MB image AND left pg
# unloadable, because npm rewrote node_modules and broke the @tina4 symlinks.
#
# So: replace each symlink with the real built package, and ship a small runtime
# manifest with no `workspaces` key. `import "@tina4/core"` resolves identically
# (node_modules/@tina4/core/package.json -> ./dist/index.js), and a derived
# `npm install <driver>` becomes an ordinary additive install.
#
# This is how the other three images already behave: PHP ships vendor/, Python
# ships site-packages, Ruby ships an installed bundle -- none of them is a
# package root the user can accidentally re-resolve.
# The framework lives at /opt/tina4, OUTSIDE /app, and the runtime manifest
# declares it with absolute `file:` specifiers. That is what makes it survive.
#
# Simply copying the packages into /app/node_modules/@tina4 is NOT enough: npm
# owns node_modules and prunes anything absent from the dependency tree, so a
# derived `npm install pg` DELETED @tina4/* and left `import "@tina4/core"`
# throwing ERR_MODULE_NOT_FOUND. Verified, not assumed.
#
# With `file:` deps npm knows about them, so it re-links instead of pruning, and
# there is still only one copy of the framework on disk.
# The framework goes to /opt/tina4/framework/, and the DIRECTORY DEPTH MATTERS.
#
# server.ts resolves the version it reports on /health and in the banner by
# walking up three levels from its own module URL:
#
#   resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json")
#
# From <root>/packages/core/dist/index.js that lands on <root>/package.json. Put
# the packages at /opt/tina4/packages/* instead and the walk lands on "/", finds
# nothing, and falls back to "0.0.0" -- which is exactly what /health started
# reporting when this layout was first tried. So the framework keeps its
# <root>/packages/<name> shape, with a manifest at <root> carrying the real
# version, and the walk resolves as designed.
RUN set -eux; \
    mkdir -p /opt/tina4/framework/packages /flat; \
    cp -R node_modules /flat/node_modules; \
    rm -rf /flat/node_modules/@tina4; \
    for p in core orm swagger frond cli; do \
      [ -d "packages/$p" ] || continue; \
      cp -R "packages/$p" "/opt/tina4/framework/packages/$p"; \
    done; \
    node -e "const fs=require('fs'); \
      const j=require('./package.json'); \
      /* the manifest server.ts walks up to -- keep name + version truthful */ \
      fs.writeFileSync('/opt/tina4/framework/package.json', \
        JSON.stringify({name:j.name,version:j.version,private:true,type:'module'},null,2)+'\n'); \
      const deps={}; \
      for (const p of ['core','orm','swagger','frond','cli']) \
        if (fs.existsSync('/opt/tina4/framework/packages/'+p)) \
          deps['@tina4/'+p]='file:/opt/tina4/framework/packages/'+p; \
      const out={name:j.name,version:j.version,private:true,type:'module',dependencies:deps}; \
      fs.writeFileSync('/flat/package.json', JSON.stringify(out,null,2)+'\n')"

FROM node:24-alpine
WORKDIR /app

# Framework out of the way at /opt/tina4; /app gets the third-party deps plus a
# plain manifest (no `workspaces`) that points at it.
COPY --from=build /opt/tina4/framework /opt/tina4/framework
COPY --from=build /flat/node_modules /app/node_modules
COPY --from=build /flat/package.json /app/package.json

# Link @tina4/* from the file: specifiers. --omit=optional keeps the DB driver
# trees out (see the build stage); no network is needed for file: deps.
RUN npm install --omit=optional --no-audit --no-fund --loglevel=error \
    && npm cache clean --force

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
