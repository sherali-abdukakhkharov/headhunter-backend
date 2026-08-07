# syntax=docker/dockerfile:1

# Container image for the Headhunter API.
#
# Four stages so the runtime layer carries only what it needs to run: the compiled
# `dist`, production dependencies, and nothing else - no pnpm, no source, no
# toolchain, no tests.
#
# Decisions that are not obvious from the instructions:
#
# - **Node 24, not 22.** `engines` allows 22, but Kysely 0.29 is pure ESM and the
#   compiled app is CJS, so the process depends on `require(esm)`. That is
#   unflagged from 22.12 onward, and 24 is what this project is developed and
#   tested against - matching it removes a class of "works locally" difference.
# - **`--node-linker=hoisted` for the production install.** pnpm's default layout is
#   a tree of symlinks into a content-addressed store, which does not survive a
#   `COPY --from` into a stage that has no store. A hoisted tree is a plain
#   directory, so it copies.
# - **`NODE_ENV` is deliberately not set here.** The Joi schema refuses
#   `OTP_STATIC_CODE` when `NODE_ENV=production`, and this deployment runs with the
#   fixed code on purpose until an SMS provider exists. Baking `production` in would
#   make the image refuse to boot with the current `.env`. Log format is controlled
#   by `LOG_PRETTY` instead, which is why that variable exists.
# - **No migrations at boot.** A container that migrates on start races with itself
#   the moment there are two replicas, and it makes a rollback a database event.
#   Migrations are run deliberately (`pnpm migrate:latest`), see docs/DEPLOYMENT.md.

ARG NODE_IMAGE=node:24-alpine
ARG PNPM_VERSION=10.30.3

# --- base: pnpm, shared by the build stages -----------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# --- deps: every dependency, for compiling --------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- build: type-check and compile ----------------------------------------------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
# `nest build` runs the full type check before SWC compiles, so a type error fails
# the image build rather than surfacing at runtime.
RUN pnpm build

# --- prod-deps: runtime dependencies only ---------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --node-linker=hoisted

# --- runtime --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and Nest's
# shutdown hooks close the Postgres pool instead of the connection being dropped.
RUN apk add --no-cache tini

WORKDIR /app

# `node` (uid 1000) ships with the image. Running as root would let a compromised
# process write to its own code.
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# Read at runtime by the health endpoint, which reports the service version.
COPY --chown=node:node package.json ./

USER node

EXPOSE 3001

# 200 is the pass condition, and `degraded` is deliberately still a 200: the health
# endpoint reports an unreachable Postgres as `degraded` rather than failing (see
# CLAUDE.md), because restarting the API does not fix the database. This check
# answers "is the process serving", which is the only question a restart can act on.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
