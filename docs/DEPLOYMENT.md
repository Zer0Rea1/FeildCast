# FieldCast — Deployment Guide

## Two modes, one config

`infra/.env` has a **DEPLOYMENT TARGET** block at the top — it's the only
thing you change to go from local/LAN testing to production:

```bash
ENABLE_SSL=false                       # true for production
DOMAIN=192.168.1.50                    # your LAN IP now → real domain later
PUBLIC_URL=http://192.168.1.50         # https://yourdomain.com in production
LIVEKIT_PUBLIC_URL=ws://192.168.1.50:7880   # wss://livekit.yourdomain.com in production
```

`nginx` reads `ENABLE_SSL` at container start and picks the matching config
automatically (`infra/nginx-select-config.sh` selects between
`nginx.plain.conf.template` and `nginx.ssl.conf.template` — no manual file
editing, no `sed`). Everything below assumes you're going straight to
production; skip DNS/certbot steps if you're only testing on your LAN.

## Requirements

- Ubuntu 22.04 VPS, **minimum 4 GB RAM** (8 GB recommended for comfort)
- 2+ vCPUs
- 20+ GB disk
- For production (`ENABLE_SSL=true`): a domain with DNS control — you need
  **2 subdomains**:
  - `yourdomain.com` — main app + API
  - `livekit.yourdomain.com` — LiveKit WebRTC signaling

---

## 1 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Verify:
```bash
docker --version       # Docker 24+
docker compose version # Docker Compose v2+
```

---

## 2 — Clone the repo

```bash
git clone https://github.com/yourorg/fieldcast.git /opt/fieldcast
cd /opt/fieldcast
```

---

## 3 — Generate LiveKit API keys

```bash
# Install LiveKit server CLI
wget https://github.com/livekit/livekit/releases/latest/download/livekit_linux_amd64.tar.gz
tar -xf livekit_linux_amd64.tar.gz
sudo mv livekit-server /usr/local/bin/

# Generate a key pair (run once, save the output)
livekit-server generate-keys
```

Output example:
```
API Key:    APIxxxxxxxxxxxxxxxx
API Secret: your-very-long-secret-string-here
```

---

## 4 — Create the environment file

```bash
cp infra/.env.example infra/.env
nano infra/.env
```

For **production**, set the deployment target block to:
```bash
ENABLE_SSL=true
DOMAIN=yourdomain.com
PUBLIC_URL=https://yourdomain.com
LIVEKIT_PUBLIC_URL=wss://livekit.yourdomain.com
```

Then fill in the rest:

```bash
DB_PASSWORD=use-openssl-rand-hex-16
JWT_SECRET=use-openssl-rand-hex-32

SRT_SERVER_HOST=your.srt-server.com   # or host.docker.internal if it runs on this same machine
SRT_SERVER_PORT=9998

LIVEKIT_API_KEY=APIxxxxxxxxxxxxxxxx        # from step 3
LIVEKIT_API_SECRET=your-long-secret        # from step 3
```

Generate strong random values:
```bash
openssl rand -hex 16   # for DB_PASSWORD
openssl rand -hex 32   # for JWT_SECRET
```

---

## 5 — Point DNS records

*Skip this step if you're testing on your LAN (`ENABLE_SSL=false`) — your LAN
IP in `infra/.env` is all you need.*

In your DNS panel, create **A records** pointing to your VPS IP:

| Record | Value |
|--------|-------|
| `yourdomain.com` | `YOUR_VPS_IP` |
| `livekit.yourdomain.com` | `YOUR_VPS_IP` |

Wait for DNS to propagate (check with `dig yourdomain.com`).

---

## 6 — Get SSL certificates

*Skip this step if you're testing on your LAN (`ENABLE_SSL=false`).*

```bash
sudo apt install -y certbot

# Stop any service on port 80 first, then:
sudo certbot certonly --standalone \
  -d yourdomain.com \
  -d livekit.yourdomain.com
```

Certificates are saved to `/etc/letsencrypt/live/`.

---

## 7 — Open firewall ports

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (redirect to HTTPS)
sudo ufw allow 443/tcp    # HTTPS

# LiveKit WebRTC — must be direct, cannot go through nginx
sudo ufw allow 7881/tcp               # LiveKit RTC TCP fallback
sudo ufw allow 50000:60000/udp        # LiveKit WebRTC media UDP

# RTMP (only needed if using LiveKit Ingress from external FFmpeg)
sudo ufw allow 1935/tcp

sudo ufw enable
```

---

## 8 — Build and start everything

```bash
cd /opt/fieldcast/infra

docker compose up -d --build
```

First build takes 5-10 minutes (compiling TypeScript, building React app, pulling images).

Monitor progress:
```bash
docker compose logs -f
```

---

## 9 — Create the first admin account

Register via the web app, then promote to admin directly in the database:

```bash
docker compose exec db psql -U fieldcast -d fieldcast \
  -c "UPDATE \"User\" SET role='ADMIN' WHERE email='your@email.com';"
```

---

## 10 — Verify everything works

```bash
# Health check
curl https://yourdomain.com/health

# Check all containers are running
docker compose ps
```

Expected output:
```
NAME              STATUS     PORTS
infra-backend-1   healthy    3000
infra-db-1        healthy    5432
infra-livekit-1   running    7880, 7881, 50000-60000/udp
infra-livekit-ingress-1  running  1935, 8080
infra-nginx-1     running    80, 443
infra-web-client-1  running  80
```

Open `https://yourdomain.com` in a browser — you should see the FieldCast login page.

---

## Memory usage summary

| Service | Limit | Notes |
|---------|-------|-------|
| PostgreSQL | 512 MB | Shared DB buffers |
| Backend | 2 GB | Node.js + FFmpeg per reporter stream |
| Web-client | 64 MB | nginx serving static files |
| LiveKit | 768 MB | ~15-30 MB per connected participant |
| LiveKit Ingress | 1 GB | FFmpeg per RTMP→WebRTC stream |
| nginx | 128 MB | Reverse proxy |
| **Total** | **~4.5 GB** | Fits a 4 GB VPS; use 8 GB for comfort |

---

## Maintenance

### Update the app

```bash
cd /opt/fieldcast
git pull

cd infra
docker compose up -d --build
```

### Renew SSL certificates

Certbot auto-renews, but add a cron to reload nginx after renewal:

```bash
sudo crontab -e
# Add this line:
0 3 * * * certbot renew --quiet && docker compose -f /opt/fieldcast/infra/docker-compose.yml exec nginx nginx -s reload
```

### View logs

```bash
docker compose logs backend     # API + FFmpeg output
docker compose logs livekit     # LiveKit SFU logs
docker compose logs nginx       # Access + error logs
docker compose logs db          # Postgres logs
```

### Stop / restart

```bash
docker compose down          # stop all
docker compose restart backend  # restart one service
```

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `502 Bad Gateway` | `docker compose logs backend` — backend may still be starting |
| LiveKit not connecting | Ensure ports 50000-60000/UDP are open in firewall; in SSL mode also check `livekit.${DOMAIN}` DNS + certs |
| Camera won't start on mobile | Production (`ENABLE_SSL=true`) must be accessed via HTTPS — browsers block camera access on plain HTTP for any host except `localhost`. LAN testing (`ENABLE_SSL=false`) works over plain HTTP only when reporters open it as `http://<DOMAIN>` where `<DOMAIN>` is a private LAN IP. |
| HLS tiles empty in admin | Reporters must be actively streaming; check `docker compose logs backend` for FFmpeg output |
| `fetch failed` on conference create | `LIVEKIT_HOST=http://livekit:7880` must match the Docker service name |
| Database migration error | `docker compose exec backend npx prisma db push --schema=src/prisma/schema.prisma` |
| nginx picked the wrong config | Check `docker compose logs nginx` for `[nginx] SSL mode` / `[nginx] Plain HTTP mode` — confirms `ENABLE_SSL` was read correctly; if wrong, `docker compose up -d --force-recreate nginx` after fixing `infra/.env` |
| Prisma `generate` fails during build | Needs OpenSSL in the builder stage — already installed in `backend/Dockerfile`; if you forked it, add `apt-get install -y openssl ca-certificates` before `npm ci` |

---

## Architecture diagram

```
Browser / Android WebView
        │
        │  HTTPS 443 (ENABLE_SSL=true)  /  HTTP 80 (ENABLE_SSL=false, LAN)
        ▼
    [nginx]  ← config picked by nginx-select-config.sh from ENABLE_SSL
        │
        ├── /api/*      → backend:3000  (REST API)
        ├── /stream     → backend:3000  (WebSocket SRT bridge)
        ├── /hls/*      → backend:3000  (HLS live preview)
        └── /*          → web-client:80 (React SPA)

Reporter phone (Go Live)
        │
        │  WebSocket binary chunks
        ▼
    backend:3000
        │
        │  FFmpeg (child process)
        ├──── SRT push ────────────────→ [Your SRT Broadcast Server]
        ├──── RTMP push ───────────────→ livekit-ingress:1935   (skipped in dual mode —
        │                                       │                reporter is already publishing
        │                                       │                directly to LiveKit via WebRTC)
        │                               publishes into LiveKit room
        │                                       ▼
        └──── HLS segments ───→ /var/www/hls/  [Admin monitor tiles]

Anchor phone / browser
        │
        │  ENABLE_SSL=true:  WSS through nginx → livekit.${DOMAIN} → livekit:7880
        │  ENABLE_SSL=false: WS directly to <DOMAIN>:7880 (port published straight
        │                    from docker-compose, not proxied by nginx)
        ▼
    [LiveKit SFU]
        │
        ├── receives reporter video — either via Ingress (FFmpeg RTMP, solo mode)
        │   or directly over WebRTC from the reporter's browser (dual mode)
        └── receives reporter audio (direct from reporter browser)
```
