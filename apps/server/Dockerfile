# apps/server image for Fly.io (fly.toml at the repo root; build context = repo root).
# Runs the TypeScript source with tsx: the workspaces have no build step (packages are
# consumed as TS source), so there is nothing to compile.
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

# Source only, path by path. Never `COPY apps/server` whole: if the builder ignores
# Dockerfile.dockerignore (it is BuildKit-specific), a local apps/server/.env (secrets, read
# by `npm run dev`) or a host node_modules would be baked into the image (TASKS K-08).
COPY packages/shared/src packages/shared/src
# The escrow IDL (imported by the chain decoder) lives outside src/.
COPY packages/shared/idl packages/shared/idl
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY apps/server/src apps/server/src

ENV NODE_ENV=production \
    PORT=8080
USER node
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "apps/server/src/main.ts"]
