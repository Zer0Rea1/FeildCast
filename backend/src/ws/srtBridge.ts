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
