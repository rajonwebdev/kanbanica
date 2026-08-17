# ── Kanbanica web app (Next.js) ───────────────────────────────────────────────
# Multi-stage build producing a lean standalone server (see next.config.mjs
# `output: "standalone"`). The background worker uses Dockerfile.worker instead.

FROM node:22-bookworm-slim AS deps

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# sharp's native binary (libvips) is dlopen'd at runtime based on platform/arch,
# which the standalone output's file-tracer can miss. node_modules/@img (the
# package holding it) is NOT hoisted to the top level under pnpm's default
# isolated linking — it only exists nested inside sharp's own private
# dependency scope (node_modules/.pnpm/sharp@<version>/node_modules/@img),
# a sibling of sharp itself, not inside it. This stage dereferences that
# entire scope (sharp + @img + its other siblings) into plain, non-symlinked
# files so they can be copied into the runner as-is below.
FROM node:22-bookworm-slim AS sharp-deps

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
RUN real_dir="$(dirname "$(readlink -f node_modules/sharp)")" \
  && mkdir -p /sharp-runtime \
  && cp -rL "$real_dir/." /sharp-runtime/


FROM node:22-bookworm-slim AS builder

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

# Nothing deployment-specific is baked into this image — no domain, no secrets,
# no VAPID key. APP_URL is read on the server at runtime, and the client fetches
# the VAPID public key from /api/push/vapid-public-key. One published image
# therefore serves any domain, and changing your domain needs no rebuild.

# Placeholders so build-time env validation (lib/env.ts) passes. These are NOT
# used at runtime — real values are injected when the container starts.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV APP_SECRET="build-time-placeholder-value-000000000000"
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build


FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Stamped by CI on release builds and reported by GET /api/health, so an
# operator can tell which build a container is running. Defaults to "dev"
# for local `docker build`.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

# uid/gid 1001 is deliberate and must not change: existing `uploads` volumes are
# owned by it, so a redeploy keeps write access. Only the account name changed.
RUN groupadd --system --gid 1001 kanbanica \
  && useradd --system --uid 1001 --gid kanbanica kanbanica

# Standalone output: server + minimal node_modules, plus static assets & public/.
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# The standalone trace leaves node_modules/sharp (and its native deps) as
# symlinks into a pruned .pnpm store missing sharp's libvips .so — COPY can't
# merge a real directory tree onto an existing symlink/file at the same path
# ("cannot copy to non-directory"), so clear those exact entries first, then
# overlay the fully-dereferenced real files from the sharp-deps stage above.
RUN rm -rf node_modules/sharp node_modules/@img node_modules/detect-libc node_modules/semver
COPY --from=sharp-deps /sharp-runtime/. ./node_modules/

# Local-storage uploads live here; mount a volume to persist across redeploys.
RUN mkdir -p /app/uploads && chown -R kanbanica:kanbanica /app/uploads
# The runtime user needs write access to .next (image-optimization cache lives
# at .next/cache) — everything copied above defaults to root ownership.
RUN chown -R kanbanica:kanbanica /app/.next

USER kanbanica
EXPOSE 3000

# /api/health is unauthenticated on purpose and checks DB reachability, so
# orchestrators can rely on this instead of declaring their own probe.
# node:22-bookworm-slim ships neither wget nor curl, so the probe uses Node's
# built-in fetch rather than pulling in an extra apt package.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# OCI metadata. This is what renders on the GitHub Packages page, and what
# links the package back to this repository.
LABEL org.opencontainers.image.title="Kanbanica" \
      org.opencontainers.image.description="Open-source, self-hosted project-management app (Workspaces → Projects/Spaces → Lists/Sprints → Tasks)." \
      org.opencontainers.image.url="https://github.com/stack256org/kanbanica" \
      org.opencontainers.image.source="https://github.com/stack256org/kanbanica" \
      org.opencontainers.image.documentation="https://github.com/stack256org/kanbanica#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Stack256"
