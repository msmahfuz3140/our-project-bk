import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth.middleware';
import { subscriptionAccessService } from '../services/subscriptionAccess.service';
import { ApiError } from '../utils/apiError';
import { AccessStatusResponse } from '../shared/subscriptions';

export interface ProtectedToolRequest extends AuthenticatedRequest {
  accessStatus?: AccessStatusResponse;
}

/**
 * Express middleware enforcing server-side subscription validation.
 * Checks authentication, database validity, start date, end date, and revocation status.
 */
export async function requireActiveSubscription(
  req: ProtectedToolRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    next(ApiError.unauthorized('Authentication token is required to access the prediction engine'));
    return;
  }

  try {
    const access = await subscriptionAccessService.checkAccess(req.user.id);

    if (!access.hasAccess) {
      next(new ApiError(403, access.reason || 'Active premium subscription required', access.code || 'SUBSCRIPTION_REQUIRED'));
      return;
    }

    req.accessStatus = access;
    next();
  } catch (error) {
    next(error);
  }
}
