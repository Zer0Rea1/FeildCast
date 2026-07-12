import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { createLiveKitRoom, deleteLiveKitRoom, generateLiveKitToken } from '../lib/livekit';

const router = Router();
const prisma = new PrismaClient();
export const conferencesRouter = router;

// POST /api/conferences — admin creates conference
router.post('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  const livekitRoom = `fc-${uuidv4().slice(0, 8)}`;
  await createLiveKitRoom(livekitRoom);

  const conference = await prisma.conference.create({
    data: {
      title,
      description,
      adminId: req.user!.userId,
      livekitRoom,
    },
  });

  res.json(conference);
});

// GET /api/conferences — list conferences (filtered by user role)
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { userId, role } = req.user!;

  let conferences;

  if (role === 'ADMIN') {
    // Admin sees all their conferences
    conferences = await prisma.conference.findMany({
      where: { adminId: userId },
      include: { participants: { include: { user: { select: { id: true, name: true, role: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  } else {
    // Reporter/anchor sees conferences they are added to
    conferences = await prisma.conference.findMany({
      where: {
        participants: { some: { userId } },
        status: { not: 'ENDED' },
      },
      include: { participants: { include: { user: { select: { id: true, name: true, role: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  res.json(conferences);
});

// GET /api/conferences/:id
router.get('/:id', requireAuth, async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const { userId, role } = req.user!;
  const conference = await prisma.conference.findUnique({
    where: { id },
    include: {
      participants: {
        include: { user: { select: { id: true, name: true, role: true } } },
      },
      admin: { select: { id: true, name: true } },
    },
  });
  if (!conference) return res.status(404).json({ error: 'Not found' });

  const isOwner       = conference.adminId === userId;
  const isParticipant = conference.participants.some(p => p.userId === userId);
  if (role === 'ADMIN' ? !isOwner : !isParticipant) {
    return res.status(403).json({ error: 'Not authorized for this conference' });
  }

  res.json(conference);
});

// POST /api/conferences/:id/livekit-token — get LiveKit join token for WebRTC
router.post('/:id/livekit-token', requireAuth, async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const { userId, role } = req.user!;

  const conference = await prisma.conference.findUnique({ where: { id } });
  if (!conference) return res.status(404).json({ error: 'Not found' });

  // Verify user is a participant, or the owning admin
  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId: id, userId } },
    include: { user: true },
  });
  const isOwningAdmin = role === 'ADMIN' && conference.adminId === userId;
  if (!participant && !isOwningAdmin) {
    return res.status(403).json({ error: 'Not authorized for this conference' });
  }

  const participantRole = participant?.role || 'ANCHOR';
  const audioOnly = participantRole === 'REPORTER';

  const token = await generateLiveKitToken(
    conference.livekitRoom,
    userId,
    participant?.user.name || 'Admin',
    audioOnly,
  );

  res.json({
    token,
    room: conference.livekitRoom,
    audioOnly,
    livekitUrl: process.env.LIVEKIT_PUBLIC_URL || 'wss://livekit.yourdomain.com',
  });
});

// GET /api/conferences/:id/streams — admin gets active SRT stream URLs for all reporters
// Returns ready-to-paste SRT URLs for playout systems (OBS, vMix, Caspar, etc.)
router.get('/:id/streams', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = String(req.params.id);

  const conference = await prisma.conference.findUnique({
    where: { id },
    include: {
      participants: {
        where: { role: 'REPORTER' },
        include: { user: { select: { name: true } } },
      },
    },
  });
  if (!conference) return res.status(404).json({ error: 'Not found' });
  if (conference.adminId !== req.user!.userId) {
    return res.status(403).json({ error: 'Not authorized for this conference' });
  }

  const srtHost    = process.env.SRT_SERVER_HOST || 'your.srt-server.com';
  const srtPort    = process.env.SRT_SERVER_PORT  || '9998';
  const srtLatency = process.env.SRT_LATENCY_MS   || '200';

  const streams = conference.participants.map(p => ({
    reporterName: p.user.name,
    streamId:     p.streamId,
    status:       p.status,
    isLive:       p.isLive,
    resolution:   p.resolution,
    bitrate:      p.bitrate,
    // mode=caller — playout connects TO the SRT server (which is in listener mode)
    srtUrl: p.streamId
      ? `srt://${process.env.vps_ip}:${process.env.vps_port}?streamid=read:${p.streamId}&mode=caller&latency=${srtLatency}`
      : null,
  }));

  res.json({
    conferenceTitle: conference.title,
    srtServer:       `${srtHost}:${srtPort}`,
    streams,
  });
});

// PATCH /api/conferences/:id/end — admin ends conference
router.patch('/:id/end', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  const existing = await prisma.conference.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.adminId !== req.user!.userId) {
    return res.status(403).json({ error: 'Not authorized for this conference' });
  }

  const conference = await prisma.conference.update({
    where: { id },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  await deleteLiveKitRoom(conference.livekitRoom);
  res.json(conference);
});
