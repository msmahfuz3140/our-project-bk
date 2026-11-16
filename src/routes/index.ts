import { Router } from 'express';
import { healthRoutes } from './health.routes';
import { authRoutes } from './auth.routes';
import { subscriptionRoutes } from './subscription.routes';
import { predictionRoutes } from './prediction.routes';
import { paymentRoutes } from './payment.routes';
import { referralRoutes } from './referral.routes';
import { dashboardRoutes } from './dashboard.routes';
import { contactRoutes } from './contact.routes';
import { toolRoutes } from './tool.routes';
import { adminRoutes } from './admin.routes';
import { moderatorRoutes } from './moderator.routes';
import { notificationRoutes } from './notification.routes';
import { dsProxyRoutes } from './dsProxy.routes';
import { walletRoutes } from './wallet.routes';
import { adminSettingsController } from '../controllers/adminSettings.controller';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/predictions', predictionRoutes);
router.use('/payments', paymentRoutes);
router.use('/referrals', referralRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/contact', contactRoutes);
router.use('/tool', toolRoutes);
router.use('/admin', adminRoutes);
router.use('/moderator', moderatorRoutes);
router.use('/notifications', notificationRoutes);
router.use('/ds', dsProxyRoutes);
router.use('/wallet', walletRoutes);

// Public website branding & operational status
router.get('/settings/public', (req, res, next) =>
  adminSettingsController.getPublicWebsiteSettings(req, res, next)
);

router.get('/tool/status', (req, res, next) =>
  adminSettingsController.getPublicToolStatus(req, res, next)
);

export const apiRoutes = router;
