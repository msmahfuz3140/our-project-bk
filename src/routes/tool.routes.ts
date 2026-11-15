import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { requireActiveSubscription, ProtectedToolRequest } from '../middleware/subscriptionAccess.middleware';

const router = Router();

/**
 * Validates that client has active server-side access to run the prediction tool.
 */
router.get('/session', requireAuth, requireActiveSubscription, (req: ProtectedToolRequest, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      authorized: true,
      accessStatus: req.accessStatus,
      user: {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role
      }
    }
  });
});

export const toolRoutes = router;
