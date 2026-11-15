import { Response, NextFunction } from 'express';
import mongoose from 'mongoose';import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { performanceMetrics } from '../middleware/performance.middleware';
import { getPaymentIndexStatus } from '../database/ensureIndexes';
import { memoryCache, cacheKeys } from '../utils/cache';
import { UserModel } from '../models/User';
import { SubscriptionModel } from '../models/Subscription';
import { PaymentModel } from '../models/Payment';
import { ContactMessageModel } from '../models/ContactMessage';
import { SecurityLogModel } from '../models/SecurityLog';
import { ReferralClickModel } from '../models/ReferralClick';
import { AuditLogModel } from '../models/AuditLog';
import { OtpVerificationModel } from '../models/OtpVerification';
import { nowPaymentsService } from '../services/nowpayments.service';

export class SystemController {
  async getSystemHealth(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const counts = await memoryCache.getOrSet(cacheKeys.adminSystemHealth, 15, async () => {
        const [
          users,
          activeUsers,
          activeSubscriptions,
          payments,
          successfulPayments,
          contactMessages,
          newContactMessages,
          securityEvents24h,
          failedLogins24h,
          referralClicks,
          auditLogs
        ] = await Promise.all([
          UserModel.countDocuments({ isDeleted: { $ne: true } }),
          UserModel.countDocuments({ isDeleted: { $ne: true }, isActive: true }),
          SubscriptionModel.countDocuments({
            status: 'ACTIVE',
            isRevoked: { $ne: true },
            endDate: { $gt: new Date() }
          }),
          PaymentModel.countDocuments(),
          PaymentModel.countDocuments({ isFulfilled: true }),
          ContactMessageModel.countDocuments(),
          ContactMessageModel.countDocuments({ status: 'NEW' }),
          SecurityLogModel.countDocuments({
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }),
          SecurityLogModel.countDocuments({
            eventType: 'LOGIN_FAILED',
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }),
          ReferralClickModel.countDocuments(),
          AuditLogModel.countDocuments()
        ]);

        return {
          users,
          activeUsers,
          activeSubscriptions,
          payments,
          successfulPayments,
          contactMessages,
          newContactMessages,
          securityEvents24h,
          failedLogins24h,
          referralClicks,
          auditLogs
        };
      });

      const db = mongoose.connection;
      const paymentConfig = nowPaymentsService.getConfigurationStatus();

      const [plaintextPasswords, rawDevOtps] = await Promise.all([
        UserModel.collection.countDocuments({ plainPassword: { $exists: true } }),
        OtpVerificationModel.collection.countDocuments({ rawCodeDev: { $exists: true } })
      ]);

      res.status(200).json({
        success: true,
        data: {
          environment: process.env.NODE_ENV || 'development',
          nodeVersion: process.version,
          database: {
            readyState: db.readyState,
            connected: db.readyState === 1,
            host: db.host,
            name: db.name
          },
          indexes: getPaymentIndexStatus(),
          securityBaseline: {
            plaintextPasswordFields: plaintextPasswords,
            rawDevelopmentOtpFields: rawDevOtps,
            bcryptCost: 12,
            csrfOriginGuard: true,
            rateLimiting: true
          },
          paymentProvider: {
            mode: paymentConfig.mode,
            apiKeyConfigured: paymentConfig.apiKeyConfigured,
            ipnSecretConfigured: paymentConfig.ipnSecretConfigured,
            webhookConfigured: Boolean(paymentConfig.webhookUrl)
          },
          collections: counts,
          performance: performanceMetrics.snapshot(),
          cache: memoryCache.getStats()
        }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const systemController = new SystemController();
