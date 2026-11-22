import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { setAuthCookies, clearAuthCookies } from '../utils/authCookies';
import { ApiError } from '../utils/apiError';

/**
 * `mustChangePassword` is account state needed by the authenticated
 * `/auth/me` endpoint, but it must not appear on credential-issuing responses.
 * Keeping the public login/registration payloads uniform prevents scanners and
 * attackers from using account metadata to distinguish responses.
 */
function publicAuthResult<T extends { user?: any }>(result: T): T {
  if (!result?.user) return result;
  const { mustChangePassword, ...user } = result.user;
  return { ...result, user };
}

export class AuthController {
  async register(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.register(req.body, req.ip, req.get('user-agent') || undefined);
      if (result.token) setAuthCookies(req, res, result.token);
      res.status(201).json({
        success: true,
        data: publicAuthResult(result)
      });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.login(req.body, req.ip, req.get('user-agent') || undefined);
      if (result.token) {
        setAuthCookies(req, res, result.token);
      } else if (result.requiresAdmin2FA) {
        // Password verification is not a session. Remove any older cookie so
        // the browser cannot continue acting as an already-authenticated admin.
        clearAuthCookies(res);
      }
      res.status(200).json({
        success: true,
        data: publicAuthResult(result)
      });
    } catch (error) {
      next(error);
    }
  }

  async verifyOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.verifyOtp(req.body);
      if (result.token) setAuthCookies(req, res, result.token);
      res.status(200).json({
        success: true,
        message: 'Account successfully verified and activated',
        data: publicAuthResult(result)
      });
    } catch (error) {
      next(error);
    }
  }

  async verifyAdminTwoFactor(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { challengeToken, code, recoveryCode } = req.body || {};
      if (!challengeToken) {
        throw ApiError.badRequest('A verification challenge token is required.', 'ADMIN_2FA_CHALLENGE_REQUIRED');
      }
      if (!code && !recoveryCode) {
        throw ApiError.badRequest('Enter your authenticator code or a recovery code.', 'ADMIN_2FA_CODE_REQUIRED');
      }

      const result = await authService.verifyAdminTwoFactor({
        challengeToken: String(challengeToken),
        code: code ? String(code) : undefined,
        recoveryCode: recoveryCode ? String(recoveryCode) : undefined,
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
        allowedPurposes: ['SETUP', 'LOGIN']
      });

      // Regenerate the full session only after the second factor succeeds.
      clearAuthCookies(res);
      if (result.token) setAuthCookies(req, res, result.token);

      res.status(200).json({
        success: true,
        message: result.recoveryCodeUsed
          ? 'Recovery code accepted. Two-step verification complete.'
          : 'Two-step verification complete.',
        data: {
          user: result.user,
          token: result.token,
          requiresAdmin2FA: false,
          recoveryCodes: result.recoveryCodes,
          recoveryCodeUsed: result.recoveryCodeUsed
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async getAdminTwoFactorStatus(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await authService.getAdminTwoFactorStatus(req.user!.id);
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async regenerateAdminRecoveryCodes(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) {
        throw ApiError.badRequest('Enter your current authenticator code.', 'ADMIN_2FA_CODE_REQUIRED');
      }
      const result = await authService.regenerateAdminRecoveryCodes(req.user!.id, code, req.ip);
      res.status(200).json({
        success: true,
        message: 'New recovery codes generated. Save them now — they will not be shown again.',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async startAdminTwoFactorReplacement(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.body?.code || '').trim();
      if (!code) {
        throw ApiError.badRequest('Enter your current authenticator code.', 'ADMIN_2FA_CODE_REQUIRED');
      }
      const data = await authService.startAdminTwoFactorReplacement(
        req.user!.id,
        code,
        req.ip,
        req.get('user-agent') || undefined
      );
      res.status(200).json({ success: true, data });
    } catch (error) {
      next(error);
    }
  }

  async verifyAdminTwoFactorReplacement(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { challengeToken, code } = req.body || {};
      if (!challengeToken || !code) {
        throw ApiError.badRequest(
          'A replacement challenge and the new authenticator code are required.',
          'ADMIN_2FA_CODE_REQUIRED'
        );
      }
      const result = await authService.verifyAdminTwoFactor({
        challengeToken: String(challengeToken),
        code: String(code),
        ip: req.ip,
        userAgent: req.get('user-agent') || undefined,
        allowedPurposes: ['REPLACE']
      });
      clearAuthCookies(res);
      if (result.token) setAuthCookies(req, res, result.token);
      res.status(200).json({
        success: true,
        message: 'Authenticator device replaced successfully.',
        data: {
          user: result.user,
          token: result.token,
          recoveryCodes: result.recoveryCodes,
          requiresAdmin2FA: false
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async disableAdminTwoFactor(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const password = String(req.body?.password || '');
      const code = String(req.body?.code || '').trim();
      if (!password || !code) {
        throw ApiError.badRequest(
          'Current password and authenticator code are required.',
          'ADMIN_2FA_REAUTH_REQUIRED'
        );
      }
      await authService.disableAdminTwoFactor(req.user!.id, password, code, req.ip);
      res.status(200).json({
        success: true,
        message: 'Two-step verification disabled. You must set it up again on your next admin login.'
      });
    } catch (error) {
      next(error);
    }
  }

  async resendOtp(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.resendOtp(req.body, req.ip);
      res.status(200).json({
        success: true,
        message: 'A fresh verification code has been dispatched',
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.forgotPassword(req.body, req.ip);
      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }

  async resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.resetPassword(req.body, req.ip, req.get('user-agent') || undefined);
      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      next(error);
    }
  }

  async changePassword(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      await authService.changePassword(req.user!.id, req.body, req.ip, req.get('user-agent') || undefined);
      res.status(200).json({
        success: true,
        message: 'Password successfully updated'
      });
    } catch (error) {
      next(error);
    }
  }

  async logout(req: Request, res: Response): Promise<void> {
    clearAuthCookies(res);
    res.status(200).json({
      success: true,
      message: 'Successfully logged out'
    });
  }

  async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    res.status(200).json({
      success: true,
      data: req.user
    });
  }

  async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.updateProfile(req.user!.id, req.body);
      res.status(200).json({
        success: true,
        message: 'Profile successfully updated',
        data: { user }
      });
    } catch (error) {
      next(error);
    }
  }
}

export const authController = new AuthController();
