# Backend — Node.js API + WebSocket SRT Bridge

## Setup

```bash
cd backend
npm init -y
npm install express ws jsonwebtoken bcryptjs prisma @prisma/client cors dotenv helmet morgan \
    @livekit/server-sdk expo-server-sdk uuid
npm install -D typescript ts-node nodemon @types/node @types/express @types/ws \
    @types/jsonwebtoken @types/bcryptjs @types/uuid
npx prisma init
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### `package.json` scripts
```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate"
  }
}
```

### `.env.example`
```
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/fieldcast"

# JWT
JWT_SECRET="change-this-to-a-long-random-string"

# Admin credentials (hashed password)
# Generate: node -e "require('bcryptjs').hash('yourpassword',12).then(console.log)"
ADMIN_PASSWORD_HASH="bcrypt-hash"

# Your existing SRT server
SRT_SERVER_HOST="your.srt-server.com"
SRT_SERVER_PORT="9998"
SRT_LATENCY_MS="200"

# HLS output directory (served as static files)
HLS_OUTPUT_DIR="/var/www/hls"

# LiveKit
LIVEKIT_HOST="http://localhost:7880"
LIVEKIT_API_KEY="your-livekit-api-key"
LIVEKIT_API_SECRET="your-livekit-api-secret"

# Server
PORT="3000"
CLIENT_URL="http://localhost:5173"
MOBILE_BASE_URL="https://yourdomain.com"
```

---

## Database Schema — `src/prisma/schema.prisma`

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl", "debian-openssl-3.0.x"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id              String        @id @default(cuid())
  name            String
  email           String        @unique
  passwordHash    String
  role            UserRole      @default(REPORTER)
  expoPushToken   String?       // for push notifications
  createdAt       DateTime      @default(now())
  conferences     Participant[]
  adminOf         Conference[]  @relation("AdminConferences")
}

model Conference {
  id           String        @id @default(cuid())
  title        String
  description  String?
  adminId      String
  admin        User          @relation("AdminConferences", fields: [adminId], references: [id])
  livekitRoom  String        @unique  // LiveKit room name
  status       ConferenceStatus @default(PENDING)
  createdAt    DateTime      @default(now())
  startedAt    DateTime?
  endedAt      DateTime?
  participants Participant[]
  sessions     StreamSession[]
}

model Participant {
  id           String      @id @default(cuid())
  conferenceId String
  conference   Conference  @relation(fields: [conferenceId], references: [id])
  userId       String
  user         User        @relation(fields: [userId], references: [id])
  role         ParticipantRole
  // Stream settings for reporters (null for anchors)
  resolution   String?     // e.g. "1280x720"
  bitrate      Int?        // kbps
  fps          Int?
  // Runtime state
  streamId     String?     // unique SRT streamid assigned on connect
  joinedAt     DateTime?
  leftAt       DateTime?
  status       ParticipantStatus @default(INVITED)

  @@unique([conferenceId, userId])
}

model StreamSession {
  id           String     @id @default(cuid())
  conferenceId String
  conference   Conference @relation(fields: [conferenceId], references: [id])
  participantId String
  startedAt    DateTime   @default(now())
  endedAt      DateTime?
  bytesSent    BigInt     @default(0)
  ffmpegPid    Int?
}

enum UserRole {
  ADMIN
  REPORTER
  ANCHOR
}

enum ParticipantRole {
  REPORTER
  ANCHOR
}

enum ConferenceStatus {
  PENDING   // created, not yet started
  LIVE      // at least one reporter is streaming
  ENDED
}

enum ParticipantStatus {
  INVITED   // added to conference, not yet joined
  JOINED    // currently in the conference
  LEFT      // left the conference
}
```

```bash
npx prisma migrate dev --name init
npx prisma generate
```

---

## Entry Point — `src/index.ts`

```typescript
import express from 'express';
import http from 'http';
import WebSocket from 'ws';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { conferencesRouter } from './routes/conferences';
import { participantsRouter } from './routes/participants';
import { handleSrtBridge } from './ws/srtBridge';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/stream' });

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());
app.use(morgan('combined'));

// Serve HLS segments for dashboard preview
app.use('/hls', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');
  next();
}, express.static(process.env.HLS_OUTPUT_DIR || '/var/www/hls'));

// REST routes
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/conferences', conferencesRouter);
app.use('/api/conferences', participantsRouter);

// Health check
app.get('/health', (_, res) => res.json({
  status: 'ok',
  srtTarget: `srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`,
}));

// WebSocket → FFmpeg → SRT bridge
wss.on('connection', handleSrtBridge);

const PORT = parseInt(process.env.PORT || '3000');
server.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  console.log(`[Server] SRT target: srt://${process.env.SRT_SERVER_HOST}:${process.env.SRT_SERVER_PORT}`);
});
```

---

## Auth Routes — `src/routes/auth.ts`

```typescript
import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();
export const authRouter = router;

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password required' });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role: role || 'REPORTER' },
  });

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { userId: user.id, role: user.role },
    process.env.JWT_SECRET!,
    { expiresIn: '30d' }
  );

  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// PATCH /api/auth/push-token — reporter saves Expo push token after login
router.patch('/push-token', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET!) as any;
  await prisma.user.update({
    where: { id: decoded.userId },
    data: { expoPushToken: req.body.expoPushToken },
  });
  res.json({ success: true });
});
```

---

## Auth Middleware — `src/middleware/auth.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthRequest extends Request {
  user?: { userId: string; role: string };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET!) as any;
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

---

## Users Routes — `src/routes/users.ts`

```typescript
import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
export const usersRouter = router;

// GET /api/users — admin gets list of all users to add to conferences
router.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});
```

---

## Conferences Routes — `src/routes/conferences.ts`

```typescript
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
  const conference = await prisma.conference.findUnique({
    where: { id: req.params.id },
    include: {
      participants: {
        include: { user: { select: { id: true, name: true, role: true } } },
      },
      admin: { select: { id: true, name: true } },
    },
  });
  if (!conference) return res.status(404).json({ error: 'Not found' });
  res.json(conference);
});

// POST /api/conferences/:id/livekit-token — get LiveKit join token for WebRTC
router.post('/:id/livekit-token', requireAuth, async (req: AuthRequest, res) => {
  const { userId, role } = req.user!;

  const conference = await prisma.conference.findUnique({ where: { id: req.params.id } });
  if (!conference) return res.status(404).json({ error: 'Not found' });

  // Verify user is a participant
  const participant = await prisma.participant.findUnique({
    where: { conferenceId_userId: { conferenceId: req.params.id, userId } },
    include: { user: true },
  });
  if (!participant && role !== 'ADMIN') {
    return res.status(403).json({ error: 'Not a participant of this conference' });
  }

  const token = await generateLiveKitToken(
    conference.livekitRoom,
    userId,
    participant?.user.name || 'Admin',
  );

  res.json({ token, room: conference.livekitRoom });
});

// PATCH /api/conferences/:id/end — admin ends conference
router.patch('/:id/end', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const conference = await prisma.conference.update({
    where: { id: req.params.id },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  await deleteLiveKitRoom(conference.livekitRoom);
  res.json(conference);
});
```

---

## Participants Routes — `src/routes/participants.ts`

```typescript
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
```
