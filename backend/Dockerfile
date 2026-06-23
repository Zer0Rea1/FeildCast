FROM node:20-bookworm-slim

# FFmpeg with SRT + libx264 support
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg openssl \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -protocols 2>&1 | grep -q srt \
    || (echo "ERROR: FFmpeg missing SRT" && exit 1)

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/prisma/schema.prisma ./src/prisma/schema.prisma
RUN CI=true NO_COLOR=1 npx prisma generate --schema=src/prisma/schema.prisma

COPY dist ./dist

RUN mkdir -p /var/www/hls

EXPOSE 3000

CMD sh -c "\
    CI=true NO_COLOR=1 npx prisma db push \
        --schema=src/prisma/schema.prisma \
        --skip-generate \
        --accept-data-loss && \
    node dist/index.js"
