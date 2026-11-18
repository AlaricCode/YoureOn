# apps/server image for Fly.io (fly.toml at the repo root; build context = repo root).
# Two stages:
#   stage    builds the projector page (apps/stage, Vite, base /stage/) and is thrown away;
#   runtime  runs the server's TypeScript source with tsx (the workspaces have no build step:
#            packages are consumed as TS source) and serves apps/stage/dist at /stage
#            (apps/server/src/stage/static.ts).
# Never `COPY <dir>` whole for an app: if the builder ignores Dockerfile.dockerignore (it is
# BuildKit-specific), a local .env (secrets, read by `npm run dev`) or a host node_modules / dist
# would be baked into the image (TASKS K-08). Everything is copied path by path.

# ---- stage: the projector page ------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim AS stage
WORKDIR /app
# apps/stage plus every workspace it links: shared, and (dev-only, for its integration tests)
# server + db. Their manifests make npm link them as workspaces, never fetch from the registry.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/stage/package.json apps/stage/
COPY apps/server/package.json apps/server/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# --include=dev: vite and its React plugin are devDependencies of the stage.
RUN npm ci --include=dev -w apps/stage --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY packages/shared/idl packages/shared/idl
COPY apps/stage/index.html apps/stage/vite.config.ts apps/stage/tsconfig.json apps/stage/
COPY apps/stage/src apps/stage/src
# public/ holds the REPLAY clips (replay/beat{n}.mp4) when they are present at deploy time.
COPY apps/stage/public apps/stage/public
# -> apps/stage/dist: index.html, hashed assets with .br/.gz siblings, public/ copied over.
RUN npm run build -w apps/stage

# ---- runtime ------------------------------------------------------------------------------------
FROM node:22.23.4-bookworm-slim

WORKDIR /app

# Manifests first, for layer caching. Only the server's workspaces are installed; other
# workspaces (apps/mobile, apps/stage) are skipped by the -w filters.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
# --include=dev: tsx (root devDependency) is the runtime loader.
RUN npm ci --include=dev --include-workspace-root -w apps/server -w packages/db -w packages/shared \
      --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Source only, path by path.
COPY packages/shared/src packages/shared/src
# The escrow IDL (imported by the chain decoder) lives outside src/.
COPY packages/shared/idl packages/shared/idl
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY apps/server/src apps/server/src
# The built stage page only (no stage sources, no node_modules of the build stage).
COPY --from=stage /app/apps/stage/dist apps/stage/dist

ENV NODE_ENV=production \
    PORT=8080
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/server/src/main.ts"]
