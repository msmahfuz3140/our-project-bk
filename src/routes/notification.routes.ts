import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { notificationController } from '../controllers/notification.controller';

const router = Router();

router.use(requireAuth);

router.get('/', (req, res, next) => notificationController.getUserNotifications(req, res, next));
router.patch('/:id/read', (req, res, next) => notificationController.markAsRead(req, res, next));
router.post('/read-all', (req, res, next) => notificationController.markAllAsRead(req, res, next));

export const notificationRoutes = router;
