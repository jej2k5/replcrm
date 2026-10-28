# ReplCRM standalone replication image.
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client now that schema.prisma is present.
RUN npx prisma generate
RUN npx tsc

FROM node:22-alpine AS runner
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
# already copied via node_modules above. Sanity check.
RUN node -e "require.resolve('@prisma/client')"

USER replcrm

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/cli.js"]
