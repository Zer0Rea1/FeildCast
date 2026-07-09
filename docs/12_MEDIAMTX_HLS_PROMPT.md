# MediaMTX HLS — Replace Existing HLS Method

## Context

MediaMTX is already installed and running on the VPS (from `11_MEDIAMTX_PROMPT.md`).
FFmpeg currently uses the `tee` muxer with 3 outputs: SRT + HLS to disk + RTMP to LiveKit Ingress.

We are simplifying FFmpeg to **one output only** (SRT to MediaMTX).
MediaMTX will handle HLS automatically from that SRT stream.
This saves CPU, disk writes, and removes manual file cleanup code.

Read these files before making any changes:
- `docs/02_BACKEND_LIBS.md` — current srtBridge.ts
- `docs/11_MEDIAMTX_PROMPT.md` — MediaMTX setup

---

## What Changes

| File | Change |
|---|---|
| `/etc/mediamtx.yml` | Enable HLS on port 8888 |
| `backend/src/ws/srtBridge.ts` | Remove tee muxer, single SRT output, remove HLS cleanup code |
| `backend/src/index.ts` | Remove HLS static middleware |
| `infra/nginx.conf` or system nginx | Proxy /hls/ to MediaMTX instead of Express |
| `backend/.env` | Remove HLS_OUTPUT_DIR (no longer needed) |

Nothing else changes. Dashboard HLS player URL stays exactly the same.

---

## Step 1 — Update MediaMTX config

```bash
sudo nano /etc/mediamtx.yml
```

Replace with:

```yaml
logLevel: info
logDestinations: [stdout]

# Management API — internal only
api: yes
apiAddress: 127.0.0.1:9997

# RTMP — keep enabled for LiveKit Ingress
rtmp: yes
rtmpAddress: :1935

# HLS — enabled, served on port 8888
hls: yes
hlsAddress: :8888
hlsAllowOrigin: "*"
hlsSegmentDuration: 2s
hlsSegmentCount: 6
hlsPartDuration: 200ms
hlsDeleteAfterNoReaders: 15s   # auto cleanup when reporter disconnects

# SRT — main input from FFmpeg
srt: yes
srtAddress: :8890

# WebRTC — disabled
webrtc: no

paths:
  all:
    publishUser:
    publishPass:
    readUser:
    readPass:
```

Restart MediaMTX:

```bash
sudo systemctl restart mediamtx
sudo systemctl status mediamtx

# Verify HLS port is listening
ss -tlnp | grep 8888
```

---

## Step 2 — Update srtBridge.ts

Replace the entire `backend/src/ws/srtBridge.ts` with this simplified version.

Key changes from current version:
- FFmpeg has ONE output only (SRT to MediaMTX)
- Removed tee muxer entirely
- Removed HLS output args
- Removed hlsDir creation
- Removed HLS file cleanup (setTimeout rmSync)
- HLS URL now points to MediaMTX instead of local files

```typescript
import WebSocket              from 'ws';
import { IncomingMessage }    from 'http';
import { spawn, ChildProcess } from 'child_process';
import jwt                    from 'jsonwebtoken';
import { PrismaClient }       from '@prisma/client';
import { generateStreamId }   from '../lib/tokenService';
import {
  createReporterIngress,
  deleteReporterIngress,
} from '../lib/livekit';
import url from 'url';

const prisma = new PrismaClient();
const activeStreams = new Map<string, ChildProcess>();

export async function handleSrtBridge(ws: WebSocket, req: IncomingMessage) {
  const query        = url.parse(req.url || '', true).query;
  const token        = query.token        as string;
  const conferenceId = query.conferenceId as string;

  if (!token || !conferenceId) {
    ws.send(JSON.stringify({ type: 'error', message: 'token and conferenceId required' }));
    ws.close(1008);
    return;
  }

  // 1. Verify JWT
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
    ws.close(1008);
    return;
  }

  const { userId } = payload;

  // 2. Verify reporter is participant of this conference
  const participant = await prisma.participant.findUnique({
    where:   { conferenceId_userId: { conferenceId, userId } },
    include: { user: true, conference: true },
  });

  if (!participant || participant.role !== 'REPORTER') {
    ws.send(JSON.stringify({ type: 'error', message: 'Not a reporter in this conference' }));
    ws.close(1008);
    return;
  }

  // 3. Prevent duplicate streams
  const streamKey = `${conferenceId}:${userId}`;
  if (activeStreams.has(streamKey)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream already active' }));
    ws.close(1008);
    return;
  }

  // 4. Generate unique streamId
  const streamId = generateStreamId(conferenceId, participant.user.name);

  // 5. Create LiveKit Ingress so anchor can watch reporter via WebRTC
  let ingressInfo: { ingressId: string; rtmpUrl: string; streamKey: string } | null = null;
  try {
    ingressInfo = await createReporterIngress(
      participant.conference.livekitRoom,
      userId,
      participant.user.name,
    );
    console.log(`[Bridge] LiveKit Ingress created for ${participant.user.name}`);
  } catch (err) {
    // Non-fatal — SRT broadcast still works without LiveKit Ingress
    console.warn(`[Bridge] LiveKit Ingress failed (non-fatal): ${err}`);
  }

  // 6. Save streamId to DB
  await prisma.participant.update({
    where: { conferenceId_userId: { conferenceId, userId } },
    data:  { streamId },
  });

  // 7. Create session record
  const session = await prisma.streamSession.create({
    data: { conferenceId, participantId: participant.id },
  });

  // 8. Build URLs
  const srtHost    = process.env.SRT_SERVER_HOST!;  // localhost
  const srtPort    = process.env.SRT_SERVER_PORT || '8890';
  const srtLatency = process.env.SRT_LATENCY_MS  || '200';

  // MediaMTX requires publish: prefix for incoming streams
  const srtUrl = `srt://${srtHost}:${srtPort}?streamid=publish:${streamId}&latency=${srtLatency}&mode=caller`;

  // HLS URL — MediaMTX serves it automatically at /STREAMID/index.m3u8
  // Nginx proxies /hls/ → MediaMTX:8888
  // So dashboard URL is /hls/STREAMID/index.m3u8 (same as before)
  const hlsUrl = `/hls/${streamId}/index.m3u8`;

  const { resolution, bitrate, fps } = participant;
  const [width, height] = (resolution || '1280x720').split('x');
  const br = bitrate || 2500;
  const fr = fps    || 25;

  console.log(`[Bridge] ${participant.user.name} → ${srtUrl} (${resolution} ${br}kbps ${fr}fps)`);

  // 9. Spawn FFmpeg — ONE output only (SRT to MediaMTX)
  //    MediaMTX handles HLS automatically from the SRT stream
  //    No tee muxer, no HLS args, no disk writes
  const ffmpegArgs: string[] = [
    // Input: WebSocket WebM chunks from reporter browser
    '-fflags', 'nobuffer',
    '-flags',  'low_delay',
    '-i',      'pipe:0',

    // Encode
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune',   'zerolatency',
    '-b:v',    `${br}k`,
    '-maxrate', `${Math.round(br * 1.2)}k`,
    '-bufsize', `${br * 2}k`,
    '-vf',     `scale=${width}:${height}`,
    '-r',      `${fr}`,
    '-g',      `${fr * 2}`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar',  '44100',

    // Output 1 — SRT to MediaMTX
    // MediaMTX serves this as HLS automatically
    // AND makes it available for OBS to pull via SRT
    '-f', 'mpegts',
    srtUrl,
  ];

  // If LiveKit Ingress is available, add RTMP as second output
  // Using tee only when Ingress is available — keeps it simple otherwise
  if (ingressInfo) {
    const rtmpTarget = `${ingressInfo.rtmpUrl}/${ingressInfo.streamKey}`;

    // Replace last two args with tee for dual output
    ffmpegArgs.splice(-2); // remove '-f', 'mpegts', srtUrl
    ffmpegArgs.push(
      '-f', 'tee',
      '-map', '0:v', '-map', '0:a',
      `[f=mpegts]${srtUrl}|[f=flv]${rtmpTarget}`,
    );
  }

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  activeStreams.set(streamKey, ffmpeg);

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim().slice(0, 200);
    if (line) console.log(`[FFmpeg:${streamId.slice(0, 14)}] ${line}`);
  });

  ffmpeg.on('exit', (code) => {
    console.log(`[Bridge] FFmpeg exited — streamId: ${streamId} code: ${code}`);
    activeStreams.delete(streamKey);
  });

  // 10. Tell reporter app it's ready
  ws.send(JSON.stringify({
    type:    'ready',
    streamId,
    hlsUrl,  // dashboard uses this
    message: 'Streaming live.',
  }));

  let bytesSent = 0;

  // 11. Pipe WebSocket binary → FFmpeg stdin
  ws.on('message', (data: Buffer | ArrayBuffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(buf);
      bytesSent += buf.length;
    }
  });

  // 12. Cleanup on disconnect
  ws.on('close', async () => {
    console.log(`[Bridge] Disconnected: ${participant.user.name} — ${(bytesSent / 1e6).toFixed(2)} MB`);

    ffmpeg.stdin.end();
    setTimeout(() => ffmpeg.kill('SIGTERM'), 2000);
    activeStreams.delete(streamKey);

    // Delete LiveKit Ingress
    if (ingressInfo) {
      await deleteReporterIngress(ingressInfo.ingressId).catch(() => {});
    }

    // No HLS file cleanup needed — MediaMTX handles it automatically
    // via hlsDeleteAfterNoReaders: 15s in mediamtx.yml

    // Update session in DB
    await prisma.streamSession.update({
      where: { id: session.id },
      data:  { endedAt: new Date(), bytesSent: BigInt(bytesSent) },
    }).catch(() => {});

    await prisma.participant.update({
      where: { conferenceId_userId: { conferenceId, userId } },
      data:  { status: 'LEFT', leftAt: new Date(), streamId: null },
    }).catch(() => {});
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] WS error: ${err.message}`);
    ffmpeg.kill('SIGTERM');
    if (ingressInfo) deleteReporterIngress(ingressInfo.ingressId).catch(() => {});
  });
}

export const getActiveStreamCount = () => activeStreams.size;
export const getActiveStreams     = () => Array.from(activeStreams.keys());
```

---

## Step 3 — Update backend/src/index.ts

Remove the HLS static middleware — MediaMTX serves HLS now, not Express.

Find and DELETE this block:

```typescript
// DELETE THIS ENTIRE BLOCK:
app.use('/hls', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  next();
}, express.static(process.env.HLS_OUTPUT_DIR || '/var/www/hls'));
```

Nothing replaces it — Nginx handles the /hls/ proxying to MediaMTX directly.

---

## Step 4 — Update Nginx config

Find the `/hls/` location block and update it to proxy to MediaMTX instead of Express.

Find:
```nginx
location /hls/ {
    proxy_pass http://localhost:3000/hls/;
    add_header Cache-Control no-cache;
    add_header Access-Control-Allow-Origin *;
}
```

Replace with:
```nginx
location /hls/ {
    # MediaMTX serves HLS at port 8888
    # Strip /hls/ prefix — MediaMTX path is just /STREAMID/index.m3u8
    proxy_pass http://localhost:8888/;
    add_header Cache-Control no-cache;
    add_header Access-Control-Allow-Origin *;
    proxy_set_header Host $host;
}
```

Test and reload Nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 5 — Update backend/.env

Remove `HLS_OUTPUT_DIR` — no longer needed:

```bash
# DELETE this line from backend/.env:
HLS_OUTPUT_DIR=/opt/fieldcast/hls_output

# Also DELETE from backend/.env.example
```

Also update SRT port to match MediaMTX:
```bash
SRT_SERVER_HOST=localhost
SRT_SERVER_PORT=8890
```

---

## Step 6 — Rebuild and restart backend

```bash
cd backend
npm run build

# PM2:
pm2 restart fieldcast-backend

# or Docker:
docker compose restart backend
```

---

## Step 7 — Open MediaMTX HLS port internally

Port 8888 does NOT need to be open in the firewall — Nginx proxies it internally.
Only 8890 UDP (SRT) needs to be publicly open.

Verify:
```bash
sudo ufw status
# 8890/udp should be ALLOW
# 8888 should NOT be listed — internal only
```

---

## Step 8 — Test the full flow

```bash
# 1. Push a test SRT stream to MediaMTX
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=25 \
  -c:v libx264 -preset ultrafast -b:v 1500k \
  -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:8890?streamid=publish:test-stream&mode=caller" &

# 2. Wait 5 seconds for MediaMTX to generate HLS segments
sleep 5

# 3. Check HLS is available from MediaMTX directly
curl -I http://localhost:8888/test-stream/index.m3u8
# Should return 200 OK

# 4. Check HLS is available via Nginx proxy
curl -I https://api.96newshd.site/hls/test-stream/index.m3u8
# Should return 200 OK

# 5. Check SRT pull URL works (from OBS or VLC)
# srt://VPS_IP:8890?streamid=read:test-stream&mode=caller

# 6. Stop test stream
kill %1
```

---

## Step 9 — Verify dashboard HLS player still works

The dashboard `HLSPlayer.tsx` component uses:
```typescript
src={`/hls/${p.streamId}/index.m3u8`}
```

This URL path stays exactly the same — Nginx now routes it to MediaMTX instead of Express.
No changes needed in the dashboard code.

Open the dashboard while a reporter is streaming and verify the video tile shows the live feed.

---

## OBS Pull URL format reminder

```
Push (FFmpeg → MediaMTX): srt://localhost:8890?streamid=publish:STREAMID&mode=caller
Pull (OBS ← MediaMTX):    srt://VPS_IP:8890?streamid=read:STREAMID&mode=caller
```

---

## Resource savings summary

| | Before | After |
|---|---|---|
| FFmpeg outputs per reporter | 3 (SRT + HLS + RTMP) | 1 or 2 (SRT only, or SRT + RTMP if Ingress available) |
| CPU per 720p reporter | ~50% core | ~35% core |
| Disk writes | Yes (HLS .ts segments) | No |
| File cleanup code | Manual setTimeout + rmSync | Removed — MediaMTX auto-cleans |
| Express static middleware | Required | Removed |
| Lines of code in srtBridge.ts | More complex | Simpler |

---

## Critical Rules

- MediaMTX HLS path format: `http://localhost:8888/STREAMID/index.m3u8` (no /hls/ prefix internally)
- Nginx strips /hls/ when proxying: `proxy_pass http://localhost:8888/` (trailing slash is required)
- SRT streamid for FFmpeg push must have `publish:` prefix: `streamid=publish:STREAMID`
- SRT streamid for OBS pull must have `read:` prefix: `streamid=read:STREAMID`
- Port 8888 is internal only — never open it in the firewall
- Port 8890 UDP must be open in the firewall — SRT is UDP not TCP
- `hlsDeleteAfterNoReaders: 15s` in mediamtx.yml handles cleanup automatically when reporter disconnects
- Do NOT keep `HLS_OUTPUT_DIR` in .env or create that directory — it's no longer used
- The `fs` import and all `fs.mkdirSync` / `fs.rmSync` calls must be removed from srtBridge.ts
