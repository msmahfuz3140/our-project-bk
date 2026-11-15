import { Router } from 'express';
import { subscriptionController } from '../controllers/subscription.controller';
import { requireAuth, requireRole } from '../middleware/auth.middleware';
import { UserRole } from '../shared/roles';

const router = Router();

// Public plans
router.get('/plans', (req, res, next) => subscriptionController.getPlans(req, res, next));

// Authenticated user subscription & real-time access status
router.get('/my-subscription', requireAuth, (req, res, next) =>
  subscriptionController.getMySubscription(req, res, next)
);

router.get('/access-status', requireAuth, (req, res, next) =>
  subscriptionController.getAccessStatus(req, res, next)
);

// Secret Code Tool Unlock
router.post('/unlock-tool', requireAuth, (req, res, next) =>
  subscriptionController.unlockTool(req, res, next)
);

// Main Admin: view all plans including hidden / inactive
router.get('/plans/all', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.getAllPlans(req, res, next)
);

// Main Admin: create new plan
router.post('/plans', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.createPlan(req, res, next)
);

// Main Admin: update plan price, features, description, status
router.patch('/plans/:planId', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.updatePlan(req, res, next)
);

// Main Admin: delete or archive plan
router.delete('/plans/:planId', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.deletePlan(req, res, next)
);

// Main Admin Controls: Manual grant, extend, revoke, list, approve, manual unlock
router.post('/admin/grant', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.grantManual(req, res, next)
);

router.post('/admin/extend', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.extend(req, res, next)
);

router.post('/admin/revoke', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.revoke(req, res, next)
);

router.post('/admin/unban', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.unban(req, res, next)
);

router.post('/admin/ban-tool', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.banUserTool(req, res, next)
);

router.post('/admin/unban-tool', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.unbanUserTool(req, res, next)
);

router.get('/admin/list', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.listAllSubscriptions(req, res, next)
);

router.post('/admin/:subscriptionId/approve', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.approveSubscription(req, res, next)
);

router.post('/admin/:subscriptionId/manual-unlock', requireAuth, requireRole(UserRole.SUPER_ADMIN), (req, res, next) =>
  subscriptionController.manuallyUnlockSubscription(req, res, next)
);

export const subscriptionRoutes = router;

