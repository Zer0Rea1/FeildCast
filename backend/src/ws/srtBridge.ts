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
const activeStreams    = new Map<string, ChildProcess>();
// Bumped on every new connection for a given reporter, so a stale delayed
// cleanup (see the ws 'close' handler) can tell whether it's still cleaning
// up after ITS OWN session or whether a newer one has since reused the same
// streamId/hlsDir — restarting a stream fast (without leaving the room)
// reuses hlsDir, and the old session's 15s-later rmSync would otherwise
// delete the new session's live segments out from under it mid-write.
const streamGeneration = new Map<string, number>();

// Strips newlines/control chars so a reporter-controlled name can't forge
// fake log lines or inject terminal escape sequences into server logs.
const forLog = (s: string) => s.replace(/[\r\n\x00-\x1f\x7f]/g, '');

const HLS_ROOT = path.resolve(process.env.HLS_OUTPUT_DIR || '/var/www/hls');

export async function handleSrtBridge(ws: WebSocket, req: IncomingMessage) {
  const query        = url.parse(req.url || '', true).query;
  const token        = query.token        as string;
  const conferenceId = query.conferenceId as string;
  // When true, the reporter is publishing their camera to LiveKit directly (dual mode),
  // so we DON'T create a LiveKit Ingress — that would make them appear twice in the room.
  const directPublish = query.directPublish === '1' || query.directPublish === 'true';

  if (!token || !conferenceId) {
    ws.send(JSON.stringify({ type: 'error', message: 'token and conferenceId required' }));
    ws.close(1008);
    return;
  }

  // 1. Verify reporter JWT
  let payload: any;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET!, { algorithms: ['HS256'] });
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

  const myGeneration = (streamGeneration.get(streamKey) || 0) + 1;
  streamGeneration.set(streamKey, myGeneration);

  // 4. Reuse the participant's existing SRT streamid if they've streamed before
  //    in this conference (e.g. reconnecting after a camera switch or dropped
  //    connection) — only mint a new one the first time, so playout software
  //    (OBS/vMix/Caspar) never needs to be reconfigured with a new stream URL.
  const streamId = participant.streamId ?? generateStreamId(conferenceId, participant.user.name);

  // 5. Create LiveKit Ingress for this reporter
  //    FFmpeg will push RTMP to this URL — LiveKit puts it in the conference room
  //    so the anchor can see the reporter without the phone uploading twice
  let ingressInfo: { ingressId: string; rtmpUrl: string; streamKey: string } | null = null;
  if (directPublish) {
    // Dual mode: reporter's phone publishes camera to LiveKit itself via WebRTC.
    // Skip Ingress entirely — FFmpeg will only tee to SRT + HLS.
    console.log(`[Bridge] ${forLog(participant.user.name)} in DUAL mode — reporter publishes to LiveKit directly, skipping Ingress`);
  } else {
    try {
      ingressInfo = await createReporterIngress(
        participant.conference.livekitRoom,
        userId,
        participant.user.name,
      );
      console.log(`[Bridge] Created LiveKit Ingress for ${forLog(participant.user.name)}: ${ingressInfo.rtmpUrl}`);
    } catch (err) {
      // Ingress failure is non-fatal — SRT broadcast still works without it
      console.warn(`[Bridge] LiveKit Ingress creation failed: ${err}. Continuing without it.`);
    }
  }

  // 6. Save streamId + mark as live. isLive is the "actively streaming right
  //    now" signal shown by the admin dashboard — kept separate from `status`
  //    (room membership: JOINED/LEFT) so stopping/restarting a stream never
  //    touches whether the reporter is considered "in the room".
  await prisma.participant.update({
    where: { conferenceId_userId: { conferenceId, userId } },
    data:  { streamId, isLive: true },
  });

  // 7. Create session record
  const session = await prisma.streamSession.create({
    data: { conferenceId, participantId: participant.id },
  });

  // 8. Build URLs
  const srtHost    = process.env.SRT_SERVER_HOST!;
  const srtPort    = process.env.SRT_SERVER_PORT    || '9998';
  const srtLatency = process.env.SRT_LATENCY_MS     || '200';
  const srtUrl     = `srt://${srtHost}:${srtPort}?streamid=publish:${streamId}&latency=${srtLatency}&mode=caller`;

  const hlsDir = path.resolve(HLS_ROOT, streamId);
  if (hlsDir !== HLS_ROOT && !hlsDir.startsWith(HLS_ROOT + path.sep)) {
    // streamId escaped the HLS root (shouldn't happen post-sanitization in
    // generateStreamId, but this is the last line of defense before any
    // filesystem call touches an attacker-influenced path).
    console.error(`[Bridge] Refusing to use HLS dir outside root: ${hlsDir}`);
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid stream state' }));
    ws.close(1011);
    return;
  }
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

  // Suppress EPIPE — happens when a WS message arrives just after FFmpeg exits
  ffmpeg.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') {
      console.error(`[Bridge:${streamId.slice(0, 14)}] stdin error: ${err.message}`);
    }
  });

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
      try {
        ffmpeg.stdin.write(buf);
        bytesSent += buf.length;
      } catch {
        // EPIPE — FFmpeg stdin closed between the writable check and the write; safe to ignore
      }
    }
  });

  // 13. On disconnect — clean everything up
  ws.on('close', async () => {
    console.log(`[Bridge] Disconnected: ${forLog(participant.user.name)} — ${(bytesSent / 1e6).toFixed(2)} MB sent`);

    ffmpeg.stdin.end();
    setTimeout(() => ffmpeg.kill('SIGTERM'), 2000);
    activeStreams.delete(streamKey);

    // Delete LiveKit Ingress
    if (ingressInfo) {
      await deleteReporterIngress(ingressInfo.ingressId).catch(() => {});
    }

    // Cleanup HLS segments after delay so player can finish buffering.
    // Guarded by generation: if the reporter has already restarted (fast
    // restart without leaving the room reuses this same hlsDir), a newer
    // generation will have claimed streamKey by the time this fires — skip
    // the delete so we don't rm the directory a live FFmpeg is writing into.
    setTimeout(() => {
      if (streamGeneration.get(streamKey) === myGeneration) {
        fs.rmSync(hlsDir, { recursive: true, force: true });
      }
    }, 15000);

    // Update DB
    await prisma.streamSession.update({
      where: { id: session.id },
      data:  { endedAt: new Date(), bytesSent: BigInt(bytesSent) },
    }).catch(() => {});

    // Keep streamId — it stays stable across reconnects (camera switches,
    // network drops) for the lifetime of this participant's conference membership.
    // Only flip isLive off here; `status` tracks room membership (set by the
    // join endpoint) and must not change just because streaming stopped.
    await prisma.participant.update({
      where: { conferenceId_userId: { conferenceId, userId } },
      data:  { isLive: false },
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
