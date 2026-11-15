import { Router } from 'express';
import { predictionController } from '../controllers/prediction.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { requireActiveSubscription } from '../middleware/subscriptionAccess.middleware';

const router = Router();

// Public lobby tables
router.get('/lobby', (req, res) => predictionController.getLobby(req, res));

// Table analysis (protected endpoint, requires active server-validated subscription)
router.get('/table/:tableId', requireAuth, requireActiveSubscription, (req, res) =>
  predictionController.getTableAnalysis(req, res)
);

export const predictionRoutes = router;
