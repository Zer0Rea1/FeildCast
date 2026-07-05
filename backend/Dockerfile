# ── Stage 1: Build TypeScript ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# Prisma's query engine needs OpenSSL to detect the right binary target —
# node:20-bookworm-slim doesn't ship it, so `prisma generate` fails without this.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Generate Prisma client, then compile TypeScript
RUN npx prisma generate --schema=src/prisma/schema.prisma
RUN npm run build

# ── Stage 2: Production runtime ───────────────────────────────────────────
FROM node:20-bookworm-slim AS runner

# FFmpeg with SRT + libx264 (required for WebSocket → SRT bridge)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        openssl \
        ca-certificates \
    && ffmpeg -protocols 2>&1 | grep -q srt \
        || { echo "ERROR: FFmpeg in this image does not support SRT protocol."; exit 1; } \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma schema + generated engine from builder (avoids re-generating)
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY src/prisma/schema.prisma ./src/prisma/schema.prisma

# Copy compiled JS
COPY --from=builder /app/dist ./dist

# HLS output directory (mounted as a volume in production)
RUN mkdir -p /var/www/hls

EXPOSE 3000

# Run Prisma migrations then start the server
CMD ["sh", "-c", \
    "npx prisma db push \
        --schema=src/prisma/schema.prisma \
        --skip-generate \
        --accept-data-loss \
    && node dist/index.js"]
