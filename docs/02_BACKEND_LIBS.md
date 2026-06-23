# Backend — Library Files & WebSocket Bridge

## LiveKit Integration — `src/lib/livekit.ts`

```typescript
import { RoomServiceClient, AccessToken } from '@livekit/server-sdk';

const livekitHost = process.env.LIVEKIT_HOST!;
const apiKey = process.env.LIVEKIT_API_KEY!;
const apiSecret = process.env.LIVEKIT_API_SECRET!;

const roomService = new RoomServiceClient(livekitHost, apiKey, apiSecret);

// Create a LiveKit room when admin creates a conference
export async function createLiveKitRoom(roomName: string): Promise<void> {
  await roomService.createRoom({
    name: roomName,
    emptyTimeout: 300,     // auto-delete after 5 min if empty
    maxParticipants: 6,    // 1 anchor + up to 5 reporters
  });
}

// Delete room when conference ends
export async function deleteLiveKitRoom(roomName: string): Promise<void> {
  try {
    await roomService.deleteRoom(roomName);
  } catch {
    // Room may already be gone — ignore
  }
}

// Generate a LiveKit access token for a participant joining a room
// This token is passed to the LiveKit SDK on the mobile app
export async function generateLiveKitToken(
  roomName: string,
  participantId: string,
  participantName: string,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, {
    identity: participantId,
    name: participantName,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}

// List active participants in a room (for admin dashboard)
export async function getRoomParticipants(roomName: string) {
  try {
    return await roomService.listParticipants(roomName);
  } catch {
    return [];
  }
}
```

---

## Push Notifications — `src/lib/pushNotifications.ts`

```typescript
import { Expo, ExpoPushMessage } from 'expo-server-sdk';

const expo = new Expo();

export async function sendPushNotification(
  expoPushToken: string,
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<void> {
  // Validate the token
  if (!Expo.isExpoPushToken(expoPushToken)) {
    console.warn(`[Push] Invalid Expo push token: ${expoPushToken}`);
    return;
  }

  const message: ExpoPushMessage = {
    to: expoPushToken,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
  };

  try {
    const chunks = expo.chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      console.log('[Push] Sent:', receipts);
    }
  } catch (err) {
    console.error('[Push] Failed to send notification:', err);
  }
}

// Send to multiple users at once (used when creating a conference with multiple participants)
export async function sendBulkPushNotification(
  tokens: string[],
  title: string,
  body: string,
  data?: Record<string, any>,
): Promise<void> {
  const validTokens = tokens.filter(t => Expo.isExpoPushToken(t));
  if (!validTokens.length) return;

  const messages: ExpoPushMessage[] = validTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
  }));

  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (err) {
    console.error('[Push] Bulk send failed:', err);
  }
}
```

---

## Token Service — `src/lib/tokenService.ts`

```typescript
import crypto from 'crypto';

// Generates a unique SRT streamid for each reporter in each conference
// Format: fc-{conferenceShortId}-{reporterShortName}-{random}
// e.g. "fc-abc123-ahmed-a1b2c3d4"
export function generateStreamId(conferenceId: string, reporterName: string): string {
  const confSlug = conferenceId.slice(0, 6);
  const nameSlug = reporterName.toLowerCase().replace(/\s+/g, '-').slice(0, 12);
  const rand = crypto.randomBytes(4).toString('hex');
  return `fc-${confSlug}-${nameSlug}-${rand}`;
}
```

---

## WebSocket SRT Bridge — `src/ws/srtBridge.ts`

```typescript
import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import { spawn, ChildProcess } from 'child_process';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { generateStreamId } from '../lib/tokenService';
import fs from 'fs';
import path from 'path';
import url from 'url';

const prisma = new PrismaClient();

// Track active streams: participantKey → ffmpeg process
const activeStreams = new Map<string, ChildProcess>();

export async function handleSrtBridge(ws: WebSocket, req: IncomingMessage) {
  const query = url.parse(req.url || '', true).query;
  const token = query.token as string;
  const conferenceId = query.conferenceId as string;

  if (!token || !conferenceId) {
    ws.send(JSON.stringify({ type: 'error', message: 'token and conferenceId required' }));
    ws.close(1008);
    return;
  }

  // Verify JWT — reporter must be logged in
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!);
  } catch {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
    ws.close(1008);
    return;
  }

  const { userId } = payload;

  // Verify reporter is a participant of this conference
  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId, userId } },
    include: { user: true, conference: true },
  });

  if (!participant || participant.role !== 'REPORTER') {
    ws.send(JSON.stringify({ type: 'error', message: 'Not a reporter in this conference' }));
    ws.close(1008);
    return;
  }

  // Check no duplicate stream from this participant
  const streamKey = `${conferenceId}:${userId}`;
  if (activeStreams.has(streamKey)) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream already active' }));
    ws.close(1008);
    return;
  }

  // Generate unique streamid for SRT server
  const streamId = generateStreamId(conferenceId, participant.user.name);

  // Save streamId to participant record
  await prisma.participant.update({
    where: { conferenceId_userId: { conferenceId, userId } },
    data: { streamId },
  });

  // Create session record
  const session = await prisma.streamSession.create({
    data: { conferenceId, participantId: participant.id },
  });

  // Build SRT URL
  const srtHost = process.env.SRT_SERVER_HOST!;
  const srtPort = process.env.SRT_SERVER_PORT || '9998';
  const srtLatency = process.env.SRT_LATENCY_MS || '200';
  const srtUrl = `srt://${srtHost}:${srtPort}?streamid=${streamId}&latency=${srtLatency}&mode=caller`;

  // HLS output directory for dashboard preview
  const hlsDir = path.join(process.env.HLS_OUTPUT_DIR || '/var/www/hls', streamId);
  fs.mkdirSync(hlsDir, { recursive: true });

  const { resolution, bitrate, fps } = participant;
  const [width, height] = (resolution || '1280x720').split('x');
  const br = bitrate || 2500;
  const fr = fps || 25;

  console.log(`[Bridge] ${participant.user.name} → ${srtUrl} (${resolution} ${br}kbps ${fr}fps)`);

  // Spawn FFmpeg with dual output: SRT + HLS
  const ffmpeg = spawn('ffmpeg', [
    // Input: WebSocket WebM chunks from reporter phone
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-i', 'pipe:0',

    // ── Output 1: SRT → your broadcast server ──
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', `${br}k`,
    '-maxrate', `${Math.round(br * 1.2)}k`,
    '-bufsize', `${br * 2}k`,
    '-vf', `scale=${width}:${height}`,
    '-r', `${fr}`,
    '-g', `${fr * 2}`,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'mpegts',
    srtUrl,

    // ── Output 2: HLS → dashboard preview ──
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', `${Math.round(br * 0.5)}k`,
    '-vf', `scale=${width}:${height}`,
    '-r', `${fr}`,
    '-g', `${fr * 2}`,
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(hlsDir, 'seg%03d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ]);

  activeStreams.set(streamKey, ffmpeg);

  ffmpeg.stderr.on('data', (data: Buffer) => {
    const line = data.toString().trim().slice(0, 200);
    if (line) console.log(`[FFmpeg:${streamId.slice(0, 16)}] ${line}`);
  });

  ffmpeg.on('exit', (code) => {
    console.log(`[Bridge] FFmpeg exited — stream: ${streamId} code: ${code}`);
    activeStreams.delete(streamKey);
  });

  // Notify reporter app: ready to receive video
  ws.send(JSON.stringify({
    type: 'ready',
    streamId,
    hlsUrl: `/hls/${streamId}/index.m3u8`,
    message: 'Connected. Streaming to SRT server.',
  }));

  let bytesSent = 0;

  // Pipe binary WebSocket messages into FFmpeg stdin
  ws.on('message', (data: Buffer | ArrayBuffer) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.write(buf);
      bytesSent += buf.length;
    }
  });

  ws.on('close', async () => {
    console.log(`[Bridge] Reporter disconnected: ${participant.user.name} — ${(bytesSent / 1e6).toFixed(2)} MB`);
    ffmpeg.stdin.end();
    setTimeout(() => ffmpeg.kill('SIGTERM'), 2000);
    activeStreams.delete(streamKey);

    // Cleanup HLS segments after delay
    setTimeout(() => {
      fs.rmSync(hlsDir, { recursive: true, force: true });
    }, 15000);

    // Update session
    await prisma.streamSession.update({
      where: { id: session.id },
      data: { endedAt: new Date(), bytesSent: BigInt(bytesSent) },
    }).catch(() => {});

    // Mark participant as left
    await prisma.participant.update({
      where: { conferenceId_userId: { conferenceId, userId } },
      data: { status: 'LEFT', leftAt: new Date(), streamId: null },
    }).catch(() => {});
  });

  ws.on('error', (err) => {
    console.error(`[Bridge] Error: ${err.message}`);
    ffmpeg.kill('SIGTERM');
  });
}

export function getActiveStreamCount(): number {
  return activeStreams.size;
}

export function getActiveStreams(): string[] {
  return Array.from(activeStreams.keys());
}
```
