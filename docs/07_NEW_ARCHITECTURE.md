# FieldCast — Corrected Architecture & Implementation

## Why This Architecture

Reporter phone sends video **once** via WebSocket to your server.
FFmpeg on the server forks it into three outputs simultaneously.
Reporter phone only uses LiveKit for **audio** (hearing the anchor).
Much lighter on mobile data — critical for reporters in remote areas.

---

## Full Data Flow

```
[Reporter Phone]
      │
      │── WebSocket (video + audio chunks) ──────────────────────────┐
      │                                                               ▼
      │── LiveKit SDK (audio only — receive anchor voice)    [Your VPS Node.js]
                                                                      │
                                                          FFmpeg reads from stdin
                                                                      │
                                              ┌───────────────────────┼─────────────────────┐
                                              ▼                       ▼                     ▼
                                    SRT push              RTMP → LiveKit Ingress        HLS segments
                                    (broadcast)           (anchor watches reporters)    (dashboard)
                                              │                       │
                                              ▼                       ▼
                                    [Your SRT Server]        [LiveKit Room]
                                              │                       │
                                              ▼                       ▼
                                       OBS → On air          [Anchor Phone]
                                                          sees all reporters
                                                          sends audio back
                                                                      │
                                                                      ▼
                                                             [LiveKit Room]
                                                                      │
                                                                      ▼
                                                          [Reporter Phone hears anchor]
```

---

## Step 1 — Enable LiveKit Ingress

LiveKit Ingress is a separate service that accepts RTMP and publishes it into a LiveKit room.

### Install LiveKit Ingress on your VPS

```bash
# Download ingress server
wget https://github.com/livekit/ingress/releases/latest/download/ingress_linux_amd64.tar.gz
tar -xf ingress_linux_amd64.tar.gz
sudo mv ingress /usr/local/bin/livekit-ingress
```

### `infra/ingress.yaml`

```yaml
api_key: YOUR_LIVEKIT_API_KEY       # same key as livekit.yaml
api_secret: YOUR_LIVEKIT_API_SECRET # same secret as livekit.yaml
ws_url: ws://localhost:7880          # your LiveKit server

# RTMP input port — FFmpeg pushes to this
rtmp_port: 1935

# HTTP port for ingress API
http_port: 8080

logging:
  level: info
```

### Run as systemd service

```bash
sudo tee /etc/systemd/system/livekit-ingress.service > /dev/null << EOF
[Unit]
Description=LiveKit Ingress
After=network.target livekit.service

[Service]
ExecStart=/usr/local/bin/livekit-ingress --config /etc/ingress.yaml
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo cp infra/ingress.yaml /etc/ingress.yaml
sudo systemctl daemon-reload
sudo systemctl enable livekit-ingress
sudo systemctl start livekit-ingress
```

### Open RTMP port on firewall

```bash
sudo ufw allow 1935/tcp   # RTMP from FFmpeg to LiveKit Ingress
# Note: this is internal (localhost) so you may not need to open it publicly
# Only open if ingress runs on a different server
```

---

## Step 2 — Create LiveKit Ingress per Reporter

When a reporter connects to the WebSocket bridge, before spawning FFmpeg,
create a LiveKit Ingress for them. This gives you an RTMP URL that FFmpeg pushes to.

### Add to `src/lib/livekit.ts`

```typescript
import {
  RoomServiceClient,
  AccessToken,
  IngressClient,
  IngressInput,
  CreateIngressOptions,
} from '@livekit/server-sdk';

const livekitHost   = process.env.LIVEKIT_HOST!;
const apiKey        = process.env.LIVEKIT_API_KEY!;
const apiSecret     = process.env.LIVEKIT_API_SECRET!;
const ingressHost   = process.env.LIVEKIT_INGRESS_HOST || 'http://localhost:8080';

const roomService   = new RoomServiceClient(livekitHost, apiKey, apiSecret);
const ingressClient = new IngressClient(ingressHost, apiKey, apiSecret);

export interface IngressInfo {
  ingressId: string;
  rtmpUrl:   string;   // e.g. rtmp://localhost:1935/live
  streamKey: string;   // unique key per reporter
}

// Call this when reporter connects to WebSocket bridge
// Creates an RTMP ingress in the LiveKit room for this reporter
export async function createReporterIngress(
  roomName:      string,
  participantId: string,
  participantName: string,
): Promise<IngressInfo> {
  const options: CreateIngressOptions = {
    name:            participantName,
    roomName,
    participantIdentity: participantId,
    participantName,
  };

  const ingress = await ingressClient.createIngress(
    IngressInput.RTMP_INPUT,
    options,
  );

  return {
    ingressId:  ingress.ingressId,
    rtmpUrl:    ingress.url,      // e.g. rtmp://your-ingress-host/live
    streamKey:  ingress.streamKey,
  };
}

// Call this when reporter disconnects — cleans up the ingress
export async function deleteReporterIngress(ingressId: string): Promise<void> {
  try {
    await ingressClient.deleteIngress(ingressId);
  } catch {
    // Ingress may already be gone
  }
}

// Existing functions below — unchanged
export async function createLiveKitRoom(roomName: string): Promise<void> {
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 300,
    maxParticipants: 10,
  });
}

export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  try { await roomService.deleteRoom(roomName); } catch {}
}

export async function generateLiveKitToken(
  roomName:        string,
  participantId:   string,
  participantName: string,
  audioOnly = false,  // reporters join audio-only, anchor joins full
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name:     participantName,
  });

  token.addGrant({
    roomJoin:       true,
    room:           roomName,
    canPublish:     !audioOnly,   // reporters don't publish video via LiveKit
    canSubscribe:   true,
    canPublishData: true,
  });

  return await token.toJwt();
}
```

---

## Step 3 — Update srtBridge.ts

This is the core change. FFmpeg now has 3 outputs instead of 2.
Before spawning FFmpeg, create a LiveKit Ingress and use its RTMP URL as the second output.

### Full updated `src/ws/srtBridge.ts`

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
import fs   from 'fs';
import path from 'path';
import url  from 'url';

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

  // 1. Verify reporter JWT
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
    ws.close(1008);
    return;
  }

  const { userId } = payload;

  // 2. Verify reporter is a REPORTER participant of this conference
  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId, userId } },
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
    ws.send(JSON.stringify({ type: 'error', message: 'Stream already active for this reporter' }));
    ws.close(1008);
    return;
  }

  // 4. Generate unique SRT streamid
  const streamId = generateStreamId(conferenceId, participant.user.name);

  // 5. Create LiveKit Ingress for this reporter
  //    FFmpeg will push RTMP to this URL — LiveKit puts it in the conference room
  //    so the anchor can see the reporter without the phone uploading twice
  let ingressInfo: { ingressId: string; rtmpUrl: string; streamKey: string } | null = null;
  try {
    ingressInfo = await createReporterIngress(
      participant.conference.livekitRoom,
      userId,
      participant.user.name,
    );
    console.log(`[Bridge] Created LiveKit Ingress for ${participant.user.name}: ${ingressInfo.rtmpUrl}`);
  } catch (err) {
    // Ingress failure is non-fatal — SRT broadcast still works without it
    console.warn(`[Bridge] LiveKit Ingress creation failed: ${err}. Continuing without it.`);
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
  const srtHost    = process.env.SRT_SERVER_HOST!;
  const srtPort    = process.env.SRT_SERVER_PORT    || '9998';
  const srtLatency = process.env.SRT_LATENCY_MS     || '200';
  const srtUrl     = `srt://${srtHost}:${srtPort}?streamid=${streamId}&latency=${srtLatency}&mode=caller`;

  const hlsDir     = path.join(process.env.HLS_OUTPUT_DIR || '/var/www/hls', streamId);
  fs.mkdirSync(hlsDir, { recursive: true });

  const { resolution, bitrate, fps } = participant;
  const [width, height] = (resolution || '1280x720').split('x');
  const br = bitrate || 2500;
  const fr = fps    || 25;

  console.log(`[Bridge] ${participant.user.name} → SRT: ${srtUrl} (${resolution} ${br}kbps ${fr}fps)`);

  // 9. Build FFmpeg args — 3 outputs
  //    Output 1: SRT  → your broadcast server (on air)
  //    Output 2: RTMP → LiveKit Ingress (anchor watches in app)
  //    Output 3: HLS  → dashboard preview
  const ffmpegArgs: string[] = [
    // ── Input: WebSocket WebM chunks from reporter phone ──────────────────
    '-fflags', 'nobuffer',
    '-flags',  'low_delay',
    '-i',      'pipe:0',

    // ── Shared video encoding settings ────────────────────────────────────
    // We encode once and tee to all 3 outputs using the tee muxer

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
  ];

  if (ingressInfo) {
    // Use tee muxer to send to all 3 destinations in one encode pass
    // This encodes video ONCE and copies the encoded stream to all outputs
    const rtmpTarget = `${ingressInfo.rtmpUrl}/${ingressInfo.streamKey}`;

    ffmpegArgs.push(
      '-f', 'tee',
      '-map', '0:v', '-map', '0:a',
      [
        // SRT broadcast
        `[f=mpegts]${srtUrl}`,
        // LiveKit Ingress RTMP
        `[f=flv]${rtmpTarget}`,
        // HLS dashboard preview — lower bitrate via scale filter
        `[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list:hls_segment_filename=${path.join(hlsDir, 'seg%03d.ts')}]${path.join(hlsDir, 'index.m3u8')}`,
      ].join('|'),
    );
  } else {
    // No LiveKit Ingress — just SRT + HLS
    ffmpegArgs.push(
      '-f', 'tee',
      '-map', '0:v', '-map', '0:a',
      [
        `[f=mpegts]${srtUrl}`,
        `[f=hls:hls_time=2:hls_list_size=6:hls_flags=delete_segments+append_list:hls_segment_filename=${path.join(hlsDir, 'seg%03d.ts')}]${path.join(hlsDir, 'index.m3u8')}`,
      ].join('|'),
    );
  }

  // 10. Spawn FFmpeg
  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  activeStreams.set(streamKey, ffmpeg);

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim().slice(0, 200);
    if (line) console.log(`[FFmpeg:${streamId.slice(0, 14)}] ${line}`);
  });

  ffmpeg.on('exit', (code) => {
    console.log(`[Bridge] FFmpeg exited — stream: ${streamId} code: ${code}`);
    activeStreams.delete(streamKey);
  });

  // 11. Notify reporter app: ready
  ws.send(JSON.stringify({
    type:    'ready',
    streamId,
    hlsUrl:  `/hls/${streamId}/index.m3u8`,
    message: 'Streaming to broadcast server.',
  }));

  let bytesSent = 0;

  // 12. Pipe WebSocket binary messages into FFmpeg stdin
  ws.on('message', (data: Buffer | ArrayBuffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(buf);
      bytesSent += buf.length;
    }
  });

  // 13. On disconnect — clean everything up
  ws.on('close', async () => {
    console.log(`[Bridge] Disconnected: ${participant.user.name} — ${(bytesSent / 1e6).toFixed(2)} MB sent`);

    ffmpeg.stdin.end();
    setTimeout(() => ffmpeg.kill('SIGTERM'), 2000);
    activeStreams.delete(streamKey);

    // Delete LiveKit Ingress
    if (ingressInfo) {
      await deleteReporterIngress(ingressInfo.ingressId).catch(() => {});
    }

    // Cleanup HLS segments after delay so player can finish buffering
    setTimeout(() => {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }, 15000);

    // Update DB
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

## Step 4 — Update LiveKit Token for Reporter (audio only)

Reporter phone joins LiveKit for **audio only** — to hear the anchor.
They do NOT publish video via LiveKit (video goes via WebSocket).

### Update `src/routes/conferences.ts` — livekit-token endpoint

```typescript
// POST /api/conferences/:id/livekit-token
router.post('/:id/livekit-token', requireAuth, async (req: AuthRequest, res) => {
  const { userId, role } = req.user!;

  const conference = await prisma.conference.findUnique({ where: { id: req.params.id } });
  if (!conference) return res.status(404).json({ error: 'Not found' });

  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId: req.params.id, userId } },
    include: { user: true },
  });

  if (!participant && role !== 'ADMIN') {
    return res.status(403).json({ error: 'Not a participant' });
  }

  const participantRole = participant?.role || 'ANCHOR';

  // Reporters join audio-only (canPublish: false for video)
  // Their video enters the room via LiveKit Ingress (FFmpeg RTMP push)
  // Anchor joins with full publish rights for their audio
  const audioOnly = participantRole === 'REPORTER';

  const token = await generateLiveKitToken(
    conference.livekitRoom,
    userId,
    participant?.user.name || 'Admin',
    audioOnly,
  );

  res.json({
    token,
    room:      conference.livekitRoom,
    audioOnly,
    livekitUrl: process.env.LIVEKIT_PUBLIC_URL || 'wss://livekit.yourdomain.com',
  });
});
```

---

## Step 5 — Update Reporter Mobile App

Reporter now:
1. Opens WebSocket → sends video stream (same as before)
2. Joins LiveKit in **audio-only** mode → hears anchor

### Update `mobile/lib/wsStream.ts` — no changes needed

The WebSocket streaming code stays exactly the same.

### Update `mobile/app/(reporter)/conference.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  AudioSession,
  useIOSAudioManagement,
  RoomProvider,
  useRoom,
  AudioTrack,
} from '@livekit/react-native';
import { mediaDevices } from 'react-native-webrtc';
import { conferencesApi } from '../../lib/api';
import { getToken } from '../../lib/auth';
import { SrtStreamer } from '../../lib/wsStream';

export default function ReporterConference() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [liveKitToken, setLiveKitToken] = useState('');
  const [liveKitUrl, setLiveKitUrl] = useState('');
  const [conference, setConference] = useState<any>(null);
  const [streamSettings, setStreamSettings] = useState({ bitrate: 2500, fps: 25, resolution: '1280x720' });
  const [streaming, setStreaming] = useState(false);
  const [duration, setDuration] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);
  const streamerRef = useRef<SrtStreamer | null>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const timerRef    = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    AudioSession.startAudioSession();
    load();
    return () => {
      AudioSession.stopAudioSession();
      clearInterval(timerRef.current);
      streamerRef.current?.stop();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  async function load() {
    try {
      const { data: conf }      = await conferencesApi.get(id);
      const { data: joinData }  = await conferencesApi.join(id);
      const { data: tkData }    = await conferencesApi.getLiveKitToken(id);

      setConference(conf);
      setStreamSettings(joinData.streamSettings);
      setLiveKitToken(tkData.token);
      setLiveKitUrl(tkData.livekitUrl);
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.error || 'Could not join');
      router.back();
    }
  }

  async function startStream() {
    const authToken = await getToken();
    if (!authToken) return;

    // Get camera + mic stream from phone
    const [w, h] = streamSettings.resolution.split('x').map(Number);
    const mediaStream = await mediaDevices.getUserMedia({
      video: { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: streamSettings.fps } },
      audio: true,
    });
    streamRef.current = mediaStream;

    const streamer = new SrtStreamer({
      onReady: () => {
        setStreaming(true);
        let elapsed = 0;
        timerRef.current = setInterval(() => setDuration(++elapsed), 1000);
      },
      onError: (msg) => { Alert.alert('Stream error', msg); setStreaming(false); },
      onStats:  (bytes) => setBytesSent(bytes),
    });

    streamerRef.current = streamer;
    await streamer.start(authToken, id, mediaStream, streamSettings.bitrate);
  }

  function stopStream() {
    streamerRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    clearInterval(timerRef.current);
    setStreaming(false);
    setDuration(0);
  }

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // Reporter joins LiveKit audio-only to hear the anchor
  // Video is NOT published via LiveKit — it goes via WebSocket → FFmpeg → LiveKit Ingress
  return (
    <View style={styles.container}>
      {/* Stream status bar */}
      <View style={styles.statusBar}>
        {streaming
          ? <Text style={styles.liveTag}>● LIVE  {fmt(duration)}  {(bytesSent/1e6).toFixed(1)} MB</Text>
          : <Text style={styles.offlineTag}>● OFFLINE</Text>
        }
      </View>

      {/* Camera preview — local only, not sent via LiveKit */}
      <View style={styles.previewPlaceholder}>
        <Text style={styles.previewText}>📹 Camera {streaming ? 'streaming' : 'ready'}</Text>
        <Text style={styles.previewSub}>{streamSettings.resolution} · {streamSettings.bitrate} kbps</Text>
      </View>

      {/* LiveKit audio-only room — reporter hears anchor */}
      {liveKitToken ? (
        <RoomProvider
          url={liveKitUrl}
          token={liveKitToken}
          connect
          audio       // publish microphone audio to LiveKit (anchor hears reporter too)
          video={false} // never publish video via LiveKit
        >
          <AnchorAudio />
        </RoomProvider>
      ) : null}

      {/* Controls */}
      <View style={styles.controls}>
        <Text style={styles.confTitle}>{conference?.title}</Text>
        <TouchableOpacity
          style={[styles.btn, streaming && styles.btnStop]}
          onPress={streaming ? stopStream : startStream}
        >
          <Text style={styles.btnText}>{streaming ? 'Stop Streaming' : 'Go Live'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.leaveBtn} onPress={() => { stopStream(); router.back(); }}>
          <Text style={styles.leaveText}>Leave Conference</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Renders audio tracks from anchor so reporter can hear them
// No UI needed — just mounts the audio tracks
function AnchorAudio() {
  const room = useRoom();
  const remoteParticipants = Array.from(room.remoteParticipants.values());

  return (
    <>
      {remoteParticipants.map(p =>
        Array.from(p.audioTrackPublications.values()).map(pub => (
          <AudioTrack key={pub.trackSid} trackPublication={pub} />
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container:          { flex: 1, backgroundColor: '#000' },
  statusBar:          { padding: 12, paddingTop: 48, flexDirection: 'row', alignItems: 'center' },
  liveTag:            { color: '#fff', backgroundColor: '#E24B4A', paddingHorizontal: 10,
                        paddingVertical: 4, borderRadius: 6, fontSize: 12, fontWeight: '700' },
  offlineTag:         { color: '#666', fontSize: 12 },
  previewPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center',
                        backgroundColor: '#111', margin: 12, borderRadius: 12 },
  previewText:        { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 6 },
  previewSub:         { color: '#666', fontSize: 12 },
  controls:           { backgroundColor: '#0a0a0a', padding: 20 },
  confTitle:          { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 14 },
  btn:                { backgroundColor: '#E24B4A', borderRadius: 10, padding: 14,
                        alignItems: 'center', marginBottom: 10 },
  btnStop:            { backgroundColor: '#333' },
  btnText:            { color: '#fff', fontSize: 15, fontWeight: '600' },
  leaveBtn:           { alignItems: 'center', padding: 10 },
  leaveText:          { color: '#666', fontSize: 13 },
});
```

---

## Step 6 — Anchor App — No Changes Needed

The anchor app already works correctly. It joins the LiveKit room and subscribes to all tracks.
Now those tracks include:
- **Reporter video** — published by LiveKit Ingress (FFmpeg RTMP push)
- **Reporter audio** — published by reporter phone directly via LiveKit

The anchor sees and hears everything. No changes to `app/(anchor)/conference.tsx`.

---

## Step 7 — Add to `.env`

```bash
# LiveKit Ingress host (usually same server, port 8080)
LIVEKIT_INGRESS_HOST=http://localhost:8080

# Public LiveKit URL for mobile app (WSS)
LIVEKIT_PUBLIC_URL=wss://livekit.yourdomain.com
```

---

## Step 8 — Add to Docker Compose

```yaml
  livekit-ingress:
    image: livekit/ingress:latest
    command: --config /etc/ingress.yaml
    volumes:
      - ./ingress.yaml:/etc/ingress.yaml
    ports:
      - "1935:1935"   # RTMP input from FFmpeg
      - "8080:8080"   # Ingress HTTP API
    depends_on:
      - livekit
    networks:
      - internal
      - external
    restart: unless-stopped
```

---

## Step 9 — Install Updated LiveKit SDK

The `@livekit/server-sdk` needs to be version 2+ for IngressClient:

```bash
cd backend
npm install @livekit/server-sdk@latest
```

Verify IngressClient is exported:
```bash
node -e "const { IngressClient } = require('@livekit/server-sdk'); console.log('OK')"
```

---

## Summary of What Changed vs Old Architecture

| Component | Old | New |
|---|---|---|
| Reporter phone uploads | Video twice (WebSocket + LiveKit) | Video once (WebSocket only) |
| Reporter LiveKit role | Publisher (video + audio) | Audio only (hear anchor) |
| Anchor video source | Reporter phone direct | FFmpeg RTMP → LiveKit Ingress |
| FFmpeg outputs | SRT + HLS | SRT + RTMP (Ingress) + HLS |
| Mobile data per reporter | ~2× bitrate | ~1× bitrate |
| New server component | None | LiveKit Ingress process |
| srtBridge.ts changes | — | Creates Ingress before FFmpeg, adds RTMP output, deletes Ingress on disconnect |
| livekit.ts changes | — | Add IngressClient, createReporterIngress, deleteReporterIngress |

---

## Testing the Full Flow

```bash
# 1. Verify FFmpeg tee muxer works
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=25 \
  -c:v libx264 -preset ultrafast -tune zerolatency -b:v 2000k \
  -c:a aac -b:a 128k \
  -f tee \
  "[f=mpegts]srt://your.srt-server.com:9998?streamid=test&mode=caller|[f=flv]rtmp://localhost:1935/live/testkey"

# If both outputs connect without error — the tee muxer works

# 2. Check LiveKit Ingress is running
curl http://localhost:8080/  
# Should return 200

# 3. Check LiveKit room after reporter connects
# Use LiveKit CLI or dashboard to see participants in the room
# Reporter's video should appear as a participant published by Ingress
```
