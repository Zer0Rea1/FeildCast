import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { sendPushNotification } from '../lib/pushNotifications';

const router = Router();
const prisma = new PrismaClient();
export const participantsRouter = router;

// POST /api/conferences/:id/participants — admin adds a user to a conference
router.post('/:id/participants', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const { userId, role, resolution, bitrate, fps } = req.body;

  if (!userId || !role) return res.status(400).json({ error: 'userId and role required' });

  const conference = await prisma.conference.findUnique({ where: { id: req.params.id } });
  if (!conference) return res.status(404).json({ error: 'Conference not found' });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  const participant = await prisma.participant.create({
    data: {
      conferenceId: req.params.id,
      userId,
      role,
      resolution: resolution || '1280x720',
      bitrate: bitrate || 2500,
      fps: fps || 25,
    },
  });

  // Send push notification to the user's device
  if (user.expoPushToken) {
    await sendPushNotification(
      user.expoPushToken,
      'You have been added to a conference',
      `${conference.title} — tap to join`,
      { conferenceId: conference.id, screen: 'conference' }
    );
  }

  res.json(participant);
});

// DELETE /api/conferences/:id/participants/:userId — admin removes participant
router.delete('/:id/participants/:userId', requireAuth, requireAdmin, async (req, res) => {
  await prisma.participant.delete({
    where: {
      conferenceId_userId: {
        conferenceId: req.params.id,
        userId: req.params.userId,
      },
    },
  });
  res.json({ success: true });
});

// PATCH /api/conferences/:id/participants/join — reporter/anchor joins conference
router.patch('/:id/participants/join', requireAuth, async (req: AuthRequest, res) => {
  const { userId } = req.user!;

  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId: req.params.id, userId } },
    include: { conference: true },
  });

  if (!participant) return res.status(403).json({ error: 'Not a participant of this conference' });

  await prisma.participant.update({
    where: { conferenceId_userId: { conferenceId: req.params.id, userId } },
    data: { status: 'JOINED', joinedAt: new Date() },
  });

  // Mark conference as LIVE when first participant joins
  if (participant.conference.status === 'PENDING') {
    await prisma.conference.update({
      where: { id: req.params.id },
      data: { status: 'LIVE', startedAt: new Date() },
    });
  }

  res.json({
    success: true,
    streamSettings: {
      resolution: participant.resolution,
      bitrate: participant.bitrate,
      fps: participant.fps,
    },
  });
});
