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
  ws.on('message', (data: WebSocket.RawData) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
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
