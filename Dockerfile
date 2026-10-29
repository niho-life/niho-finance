# syntax=docker/dockerfile:1
# NIHO finance on Cloud Run. Built by Cloud Build (cloudbuild.yaml) into two images from this file:
#   runtime  — the web app and the jobs service (`node apps/web/server.js`, Next.js standalone)
#   migrate  — `prisma migrate deploy` + scripts/db/grants.sql (Cloud Run job, run before each deploy)
# Local check (arm64 Mac): docker build --target runtime -t niho-finance:dev .

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false
# Prisma's query engine needs OpenSSL at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ---------------------------------------------------------------------------
# deps: the full workspace install (dev dependencies included: next build and prisma need them).
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/ledger/package.json packages/ledger/
COPY packages/importers/package.json packages/importers/
COPY packages/reports/package.json packages/reports/
# postinstall runs `prisma generate` in packages/db: it needs the schema and the config.
COPY packages/db/prisma ./packages/db/prisma
COPY packages/db/prisma.config.ts ./packages/db/prisma.config.ts
COPY packages/db/src/env.ts ./packages/db/src/env.ts
RUN npm ci

# ---------------------------------------------------------------------------
# build: next build (standalone output, see apps/web/next.config.ts)
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm -C apps/web run build

# ---------------------------------------------------------------------------
# runtime: web + jobs
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# The standalone output leaves out public/: the home-screen app's manifest, icons, service worker
# and offline page (10 §1.1).
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 8080
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# migrate: prisma migrate deploy + grants (Cloud Run job)
# ---------------------------------------------------------------------------
FROM deps AS migrate
ENV NODE_ENV=production
COPY packages/db ./packages/db
COPY scripts/db ./scripts/db
USER node
CMD ["bash", "/app/scripts/db/migrate.sh"]
