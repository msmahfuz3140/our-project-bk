import { env } from '../config/env';
import { AccountStatus, IUser } from '../models/User';
import { transactionalEmailService } from './transactionalEmail.service';
import { accountStatus } from './emailTemplates';
import { logger } from '../utils/logger';

export type AccountStatusAction = 'BLOCK' | 'UNBLOCK' | 'SUSPEND';

/**
 * Sends exactly one account status notification for a real status transition.
 * Repeated processing of the same ban/suspension does not send a duplicate.
 */
export async function sendAccountStatusNotification(params: {
  user: IUser;
  action: AccountStatusAction;
  previousStatus: AccountStatus;
  reason?: string;
  effectiveAt?: Date;
}): Promise<void> {
  const targetStatus =
    params.action === 'BLOCK'
      ? AccountStatus.BLOCKED
      : params.action === 'SUSPEND'
        ? AccountStatus.SUSPENDED
        : AccountStatus.ACTIVE;

  if (params.previousStatus === targetStatus) return;
  if (!params.user.email) return;

  const status: 'BANNED' | 'SUSPENDED' | 'RESTORED' =
    params.action === 'BLOCK' ? 'BANNED' : params.action === 'SUSPEND' ? 'SUSPENDED' : 'RESTORED';

  const effectiveAt = params.effectiveAt || params.user.statusChangedAt || new Date();
  const templateKey =
    status === 'BANNED' ? 'ACCOUNT_BANNED' : status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_RESTORED';

  try {
    const rendered = accountStatus({
      name: params.user.name,
      status,
      effectiveAt,
      reason: params.reason,
      suspendedUntil: params.user.suspendedUntil,
      supportUrl: `${env.PUBLIC_FRONTEND_URL.replace(/\/$/, '')}/contact`
    });

    await transactionalEmailService.send({
      idempotencyKey: `account-${params.action.toLowerCase()}:${params.user._id}:${new Date(effectiveAt).toISOString()}`,
      userId: params.user._id,
      toEmail: params.user.email,
      templateKey,
      rendered,
      metadata: {
        action: params.action,
        previousStatus: params.previousStatus,
        newStatus: targetStatus,
        suspendedUntil: params.user.suspendedUntil?.toISOString()
      }
    });
  } catch (error: any) {
    // Notification failures never roll back an administrative action.
    logger.error('Account status email could not be queued', {
      userId: params.user._id.toString(),
      action: params.action,
      error: error?.message
    });
  }
}
