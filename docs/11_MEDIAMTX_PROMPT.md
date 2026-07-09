# MediaMTX SRT Server — Implementation Prompt

## Context

FieldCast backend is already built and running.
FFmpeg currently pushes SRT to an external SRT server configured via `SRT_SERVER_HOST` and `SRT_SERVER_PORT` in `.env`.

We are replacing that external SRT server with **MediaMTX** running on the same VPS.
MediaMTX is a single binary, zero config, free, open source SRT server.
It accepts multiple SRT streams on one port, identified by streamid.

Read `docs/02_BACKEND_LIBS.md` for the current srtBridge.ts before making changes.

---

## What Changes

Only 3 things change:

1. **Install MediaMTX** on the VPS
2. **Update `.env`** — point SRT target to localhost instead of external server
3. **Update `nginx.conf`** — expose MediaMTX SRT port publicly so OBS can pull

Nothing else changes. `srtBridge.ts`, FFmpeg args, database, API routes — all untouched.

---

## Step 1 — Install MediaMTX on VPS

```bash
# SSH into your VPS
ssh root@YOUR_VPS_IP

# Download latest MediaMTX
wget https://github.com/bluenviron/mediamtx/releases/latest/download/mediamtx_linux_amd64.tar.gz
tar -xf mediamtx_linux_amd64.tar.gz
sudo mv mediamtx /usr/local/bin/mediamtx
sudo mv mediamtx.yml /etc/mediamtx.yml

# Verify it works
mediamtx --version
```

---

## Step 2 — Configure MediaMTX

```bash
sudo nano /etc/mediamtx.yml
```

Replace entire content with:

```yaml
# MediaMTX config for FieldCast
# Accepts SRT streams from FFmpeg, serves them for OBS/playout to pull

logLevel: info
logDestinations: [stdout]

# API for management (optional)
api: yes
apiAddress: 127.0.0.1:9997

# RTMP — disabled (we use RTMP only for LiveKit Ingress internally)
rtmp: no

# HLS — disabled (backend FFmpeg handles HLS separately)
hls: no

# WebRTC — disabled
webrtc: no

# SRT server — this is what we need
srt: yes
srtAddress: :8890

# Path config — accept any streamid
paths:
  all:
    # Anyone can publish (our FFmpeg pushes here)
    publishUser:
    publishPass:
    # Anyone can read (OBS pulls from here)
    readUser:
    readPass:
```

---

## Step 3 — Run MediaMTX as a systemd service

```bash
sudo tee /etc/systemd/system/mediamtx.service > /dev/null << EOF
[Unit]
Description=MediaMTX SRT Server
After=network.target

[Service]
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx.yml
Restart=always
RestartSec=5
User=root
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mediamtx
sudo systemctl start mediamtx

# Verify it's running
sudo systemctl status mediamtx

# Check it's listening on 8890
ss -ulnp | grep 8890
```

---

## Step 4 — Open firewall port

```bash
# SRT uses UDP
sudo ufw allow 8890/udp
sudo ufw reload
sudo ufw status
```

---

## Step 5 — Update backend .env

Change these two lines in `backend/.env`:

```bash
# Before:
SRT_SERVER_HOST=your-old-srt-server.com
SRT_SERVER_PORT=9998

# After — MediaMTX running locally on same VPS:
SRT_SERVER_HOST=localhost
SRT_SERVER_PORT=8890
```

Restart backend:

```bash
pm2 restart fieldcast-backend
# or if using Docker:
docker compose restart backend
```

---

## Step 6 — Verify FFmpeg → MediaMTX works

Test with a dummy stream before using the real app:

```bash
# Push a test stream to MediaMTX
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=25 \
  -c:v libx264 -preset ultrafast -tune zerolatency -b:v 1500k \
  -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:8890?streamid=publish:test-stream&mode=caller"

# In another terminal — verify MediaMTX received it
curl http://localhost:9997/v3/paths/list
# Should show test-stream in the list with "ready: true"
```

---

## Step 7 — Pull the stream in OBS

On any machine that can reach your VPS:

```
OBS → Sources → + → Media Source
Name: Reporter Ahmed

Settings:
  ✅ Uncheck "Local File"
  Input: srt://VPS_IP:8890?streamid=read:fc-abc123-ahmed-xxx&mode=caller
  Input Format: mpegts
  ✅ Check "Restart playback when source becomes active"
```

**Important** — MediaMTX uses `publish:STREAMID` for pushing and `read:STREAMID` for pulling:

```
FFmpeg pushes to:  srt://VPS_IP:8890?streamid=publish:STREAMID
OBS pulls from:    srt://VPS_IP:8890?streamid=read:STREAMID
```

---

## Step 8 — Update srtBridge.ts streamid format

MediaMTX expects streamids in the format `publish:STREAMID`.
Update the SRT URL in `backend/src/ws/srtBridge.ts`:

```typescript
// Before:
const srtUrl = `srt://${srtHost}:${srtPort}?streamid=${streamId}&latency=${srtLatency}&mode=caller`;

// After — MediaMTX requires publish: prefix:
const srtUrl = `srt://${srtHost}:${srtPort}?streamid=publish:${streamId}&latency=${srtLatency}&mode=caller`;
```

Rebuild backend:

```bash
cd backend
npm run build
pm2 restart fieldcast-backend
```

---

## Step 9 — Update dashboard to show pull URL

In `dashboard/src/pages/ConferenceDetail.tsx` or wherever you show stream info,
display the OBS pull URL for each reporter so the broadcast team can copy it easily:

```tsx
// Add this under each reporter's HLS tile
{p.streamId && (
  <div style={{ marginTop: 8, padding: '8px 12px',
    background: '#0a0a0a', borderRadius: 6, fontSize: 11 }}>
    <span style={{ color: '#666' }}>OBS pull URL: </span>
    <code style={{ color: '#1D9E75' }}>
      srt://YOUR_VPS_IP:8890?streamid=read:{p.streamId}&mode=caller
    </code>
    <button
      onClick={() => navigator.clipboard.writeText(
        `srt://YOUR_VPS_IP:8890?streamid=read:${p.streamId}&mode=caller`
      )}
      style={{ marginLeft: 8, fontSize: 10, padding: '2px 6px',
        background: '#333', border: 'none', color: '#fff',
        borderRadius: 4, cursor: 'pointer' }}
    >
      Copy
    </button>
  </div>
)}
```

Replace `YOUR_VPS_IP` with an environment variable:

```typescript
const VPS_IP = import.meta.env.VITE_VPS_IP || 'YOUR_VPS_IP';
```

Add to `dashboard/.env`:
```bash
VITE_VPS_IP=your.vps.ip.here
VITE_SRT_PORT=8890
```

---

## Step 10 — PM2 ecosystem update (if using PM2)

Add MediaMTX to your `ecosystem.config.js` so PM2 manages it:

```javascript
module.exports = {
  apps: [
    {
      name: 'fieldcast-backend',
      cwd: '/opt/fieldcast/backend',
      script: 'dist/index.js',
      // ... existing config
    },
    {
      // Add this block
      name: 'mediamtx',
      script: '/usr/local/bin/mediamtx',
      args: '/etc/mediamtx.yml',
      interpreter: 'none',
      restart_delay: 3000,
      max_restarts: 10,
      error_file: '/var/log/fieldcast/mediamtx-error.log',
      out_file:   '/var/log/fieldcast/mediamtx-out.log',
    },
  ],
};
```

```bash
pm2 restart all
pm2 save
```

---

## Full flow after implementation

```
[Reporter Phone — web app]
        │
        │ WebSocket (WebM video chunks)
        ▼
[Node.js backend — srtBridge.ts]
        │
        │ spawns FFmpeg per reporter
        ▼
[FFmpeg]
        │
        ├──→ srt://localhost:8890?streamid=publish:fc-xxx&mode=caller
        │           │
        │           ▼
        │    [MediaMTX — port 8890]
        │           │
        │           └──→ OBS pulls: srt://VPS_IP:8890?streamid=read:fc-xxx
        │                VLC pulls: srt://VPS_IP:8890?streamid=read:fc-xxx
        │                Flussonic: srt://VPS_IP:8890?streamid=read:fc-xxx
        │                Anyone:    srt://VPS_IP:8890?streamid=read:fc-xxx
        │
        ├──→ rtmp://localhost:1935/live/STREAMID (LiveKit Ingress)
        │
        └──→ /hls/STREAMID/index.m3u8 (dashboard preview)
```

---

## Verify everything is working

```bash
# 1. MediaMTX running
sudo systemctl status mediamtx

# 2. Port open
ss -ulnp | grep 8890

# 3. Active streams (when reporter is live)
curl http://localhost:9997/v3/paths/list | python3 -m json.tool

# 4. Backend logs show correct SRT target
pm2 logs fieldcast-backend | grep SRT
# Should show: srt://localhost:8890

# 5. Test pull from OBS on another machine
# srt://YOUR_VPS_IP:8890?streamid=read:STREAMID&mode=caller
```

---

## Critical Rules

- MediaMTX SRT port is **8890 UDP** — must be open in firewall
- FFmpeg pushes with `publish:` prefix: `streamid=publish:STREAMID`
- OBS pulls with `read:` prefix: `streamid=read:STREAMID`
- MediaMTX API runs on `127.0.0.1:9997` — internal only, do NOT expose publicly
- SRT_SERVER_HOST in backend .env must be `localhost` (not 127.0.0.1 — FFmpeg handles them differently for SRT)
- Do NOT add MediaMTX to Nginx — SRT is UDP, Nginx cannot proxy UDP
- MediaMTX runs alongside Flussonic with no conflict — they use different ports
