import { Router } from 'express';
import { moderatorController } from '../controllers/moderator.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Strictly enforce MODERATOR role authorization
router.use(requireAuth);
router.use(requireRole(UserRole.MODERATOR));

router.get('/dashboard', (req, res, next) =>
  moderatorController.getModeratorSelfDashboard(req, res, next)
);

router.get('/commissions', (req, res, next) =>
  moderatorController.getModeratorSelfCommissions(req, res, next)
);

router.get('/referred-users', (req, res, next) =>
  moderatorController.getModeratorSelfReferredUsers(req, res, next)
);

export const moderatorRoutes = router;
