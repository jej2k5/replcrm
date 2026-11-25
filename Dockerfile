# ReplCRM standalone replication image.
# The base is pinned by digest so every build uses the inventoried Node and Alpine release.
# licenses/NODEJS-22.23.5-LICENSE.txt matches this Node version; update both together.
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client now that schema.prisma is present.
RUN npx prisma generate
RUN npx tsc
# Drop build-only packages (TypeScript, tsx, PGlite, type definitions). The Prisma CLI stays:
# it is a production dependency in the lockfile, and console setup runs `prisma migrate deploy`.
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
# tini gives us PID 1 signal forwarding so SIGTERM propagates cleanly to
# node and its database client.
RUN apk add --no-cache openssl tini

# Run as a non-root application user.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 replcrm

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/prisma       ./prisma
COPY package.json LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY licenses ./licenses

# Prisma client (generated artifacts) lives under node_modules/.prisma —
# already copied via node_modules above. Sanity check, including the CLI setup uses.
RUN node -e "require.resolve('@prisma/client'); require.resolve('./node_modules/prisma/build/index.js')"
# The shipped Node license must match the runtime.
RUN test "$(node --version)" = "v22.23.5" && test -s licenses/NODEJS-22.23.5-LICENSE.txt

USER replcrm

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/cli.js"]
