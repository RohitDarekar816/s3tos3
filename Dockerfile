# ── Stage 1: install dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# ci install: reproducible, skips devDeps, respects lockfile
RUN npm ci --omit=dev

# ── Stage 2: runtime image ─────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Non-root user for least-privilege execution
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what the app needs
COPY --from=deps /app/node_modules ./node_modules
COPY server.js ./
COPY src/         ./src/
COPY public/      ./public/

# Persistent volumes for data and logs
RUN mkdir -p data/checkpoints logs \
    && chown -R appuser:appgroup /app

USER appuser

# Default port — override with PORT env var
EXPOSE 3000

# Healthcheck: poll the /health endpoint every 30s
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-3000}/ping || exit 1

ENV NODE_ENV=production

CMD ["node", "server.js"]
