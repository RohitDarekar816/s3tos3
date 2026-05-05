# ── Stage 1: install production dependencies ──────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# Install production dependencies.
# Using npm install --omit=dev instead of npm ci because the lock file
# was generated with dev dependencies included (fast-check has native
# transitive deps that npm ci --omit=dev incorrectly flags as missing).
RUN npm install --omit=dev --no-audit --no-fund

# ── Stage 2: production runtime ────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Install PostgreSQL client tools (pg_dump, pg_restore, psql) needed for
# the database backup feature. Use the same major version as your databases.
RUN apk add --no-cache postgresql16-client

# Non-root user for least-privilege execution
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY server.js ./
COPY src/       ./src/
COPY public/    ./public/

# Create persistent-volume mount points and set ownership
RUN mkdir -p data logs dbbackup \
    && chown -R appuser:appgroup /app

USER appuser

# Default port — override with PORT env var
EXPOSE 3000

# Healthcheck: lightweight ping endpoint (no auth required)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/ping || exit 1

ENV NODE_ENV=production

# Use exec form so Node receives SIGTERM directly (no shell wrapper)
CMD ["node", "server.js"]
