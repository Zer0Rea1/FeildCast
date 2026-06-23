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
