import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import rateLimit from 'express-rate-limit';

const router = Router();
const prisma = new PrismaClient();
export const authRouter = router;

// Login: bound brute-force/credential-stuffing attempts per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

// Register: bound mass account creation per IP.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this network. Try again later.' },
});

// Self-registration may only ever grant these roles. ADMIN accounts must be
// created by an existing admin via PATCH /api/users/:id/role, never by the
// registering user themselves.
const SELF_REGISTERABLE_ROLES = ['REPORTER', 'ANCHOR'];

// POST /api/auth/register
router.post('/register', registerLimiter, async (req: Request, res: Response) => {
  const { name, email, password, role, designation, city } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password required' });
  }
  if (role !== undefined && !SELF_REGISTERABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${SELF_REGISTERABLE_ROLES.join(', ')}` });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash,
        role: role || 'REPORTER',
        designation,
        city,
      },
    });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        designation: user.designation,
        city: user.city,
      },
    });
  } catch (err: any) {
    // Duplicate-email race: two concurrent registrations can both pass the
    // findUnique check above before either INSERT commits.
    if (err?.code === 'P2002') return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
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

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      designation: user.designation,
      city: user.city,
    },
  });
});

// PATCH /api/auth/push-token — reporter saves Expo push token after login
router.patch('/push-token', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });

  let decoded: any;
  try {
    decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET!, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  await prisma.user.update({
    where: { id: decoded.userId },
    data: { expoPushToken: req.body.expoPushToken },
  });
  res.json({ success: true });
});
