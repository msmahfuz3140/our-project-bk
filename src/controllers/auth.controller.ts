import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { setAuthCookies, clearAuthCookies } from '../utils/authCookies';

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
      if (result.token) setAuthCookies(req, res, result.token);
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
