# Infrastructure — LiveKit, Docker, Deployment

## LiveKit Server Setup

LiveKit is the WebRTC SFU that handles real-time communication between anchor and reporters.

### Install on Ubuntu

```bash
# Download latest LiveKit server
wget https://github.com/livekit/livekit/releases/latest/download/livekit_linux_amd64.tar.gz
tar -xf livekit_linux_amd64.tar.gz
sudo mv livekit /usr/local/bin/livekit-server

# Generate API key and secret (save these in your .env)
livekit-server generate-keys
# Output: API Key: APIXXX...   Secret: ...
```

### `infra/livekit.yaml`

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true   # required if running behind NAT/cloud VPS

keys:
  # Replace with output from generate-keys
  APIYOURKEYHERE: YOURSECRETHERE

# Room settings
room:
  empty_timeout: 300      # delete room after 5 min if empty
  max_participants: 6

logging:
  level: info
```

### Run as systemd service

```bash
sudo tee /etc/systemd/system/livekit.service > /dev/null << EOF
[Unit]
Description=LiveKit WebRTC Server
After=network.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit.yaml
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo cp infra/livekit.yaml /etc/livekit.yaml
sudo systemctl daemon-reload
sudo systemctl enable livekit
sudo systemctl start livekit
```

---

## Docker Compose — `infra/docker-compose.yml`

```yaml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: fieldcast
      POSTGRES_USER: fieldcast
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fieldcast"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - internal

  backend:
    build:
      context: ../backend
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgresql://fieldcast:${DB_PASSWORD}@db:5432/fieldcast
      JWT_SECRET: ${JWT_SECRET}
      SRT_SERVER_HOST: ${SRT_SERVER_HOST}
      SRT_SERVER_PORT: ${SRT_SERVER_PORT}
      SRT_LATENCY_MS: ${SRT_LATENCY_MS:-200}
      HLS_OUTPUT_DIR: /var/www/hls
      LIVEKIT_HOST: http://livekit:7880
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      PORT: 3000
      CLIENT_URL: https://admin.yourdomain.com
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - hls-data:/var/www/hls
    ports:
      - "3000:3000"
    networks:
      - internal
      - external
    restart: unless-stopped

  dashboard:
    build:
      context: ../dashboard
      dockerfile: Dockerfile
    networks:
      - external
    restart: unless-stopped

  livekit:
    image: livekit/livekit-server:latest
    command: --config /etc/livekit.yaml
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml
    ports:
      - "7880:7880"
      - "7881:7881"
      - "50000-60000:50000-60000/udp"
    networks:
      - internal
      - external
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - backend
      - dashboard
    networks:
      - external
    restart: unless-stopped

volumes:
  pgdata:
  hls-data:

networks:
  internal:
    internal: true
  external:
```

### `infra/.env`
```bash
DB_PASSWORD=strong-random-password
JWT_SECRET=run-openssl-rand-hex-32
SRT_SERVER_HOST=your.srt-server.com
SRT_SERVER_PORT=9998
SRT_LATENCY_MS=200
LIVEKIT_API_KEY=APIxxxxxxxxxxxxxxxx
LIVEKIT_API_SECRET=yourlonglivekitsecret
```

---

## Backend Dockerfile — `backend/Dockerfile`

```dockerfile
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
```

---

## Nginx Config — `infra/nginx.conf`

```nginx
events { worker_connections 1024; }

http {
  # Backend API + WebSocket + HLS
  server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location /api/ {
      proxy_pass http://backend:3000/api/;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
    }

    # WebSocket — reporter phone streams here
    location /stream {
      proxy_pass http://backend:3000/stream;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 86400s;
      proxy_send_timeout 86400s;
      proxy_buffers 32 256k;
      proxy_buffer_size 256k;
    }

    # HLS segments for dashboard preview
    location /hls/ {
      proxy_pass http://backend:3000/hls/;
      add_header Cache-Control no-cache;
      add_header Access-Control-Allow-Origin *;
    }

    location /health {
      proxy_pass http://backend:3000/health;
    }
  }

  # Admin dashboard
  server {
    listen 443 ssl;
    server_name admin.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/admin.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/admin.yourdomain.com/privkey.pem;

    location / {
      proxy_pass http://dashboard:80;
      proxy_set_header Host $host;
    }

    location /api/ {
      proxy_pass http://backend:3000/api/;
    }
  }

  # LiveKit WebSocket (for mobile app WebRTC)
  server {
    listen 443 ssl;
    server_name livekit.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/livekit.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/livekit.yourdomain.com/privkey.pem;

    location / {
      proxy_pass http://livekit:7880;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 86400s;
    }
  }

  server {
    listen 80;
    return 301 https://$host$request_uri;
  }
}
```

---

## Firewall Rules

```bash
sudo ufw allow 22       # SSH
sudo ufw allow 80       # HTTP
sudo ufw allow 443      # HTTPS

# LiveKit WebRTC UDP media ports
sudo ufw allow 50000:60000/udp

# LiveKit TCP (fallback for WebRTC)
sudo ufw allow 7881/tcp

sudo ufw enable
```

Note: SRT port does NOT need to be open on this server — FFmpeg connects outbound to your SRT server.

---

## Deployment Steps

```bash
# 1. Clone project
git clone https://github.com/yourorg/fieldcast.git /opt/fieldcast
cd /opt/fieldcast

# 2. Build backend
cd backend
npm ci
npx prisma generate --schema=src/prisma/schema.prisma
npm run build
cd ..

# 3. Build dashboard
cd dashboard
npm ci
npm run build
cd ..

# 4. Update mobile app WS and LiveKit URLs
# In mobile/lib/api.ts: update BASE_URL
# In mobile/lib/wsStream.ts: update WS_URL
# In mobile/app/(anchor)/conference.tsx: update LIVEKIT_URL

# 5. Set environment variables
cp infra/.env.example infra/.env
nano infra/.env   # fill all values

# 6. Get SSL certificates
sudo certbot certonly --standalone \
  -d yourdomain.com \
  -d admin.yourdomain.com \
  -d livekit.yourdomain.com

# 7. Start everything
cd infra
docker compose up -d --build

# 8. Verify
curl https://yourdomain.com/health
```
