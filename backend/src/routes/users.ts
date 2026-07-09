import { Router } from 'express';
import { PrismaClient, UserRole } from '@prisma/client';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
export const usersRouter = router;

// GET /api/users — admin gets list of all users
router.get('/', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, designation: true, city: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

// PATCH /api/users/:id/role — admin changes a user's role
router.patch('/:id/role', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const roleInput: string = String(req.body.role ?? '');
  if (!['REPORTER', 'ANCHOR'].includes(roleInput)) {
    return res.status(400).json({ error: 'Role must be REPORTER or ANCHOR' });
  }
  const role = roleInput as UserRole;
  const user = await prisma.user.update({
    where: { id: String(req.params.id) },
    data: { role },
    select: { id: true, name: true, email: true, role: true },
  });
  res.json(user);
});
