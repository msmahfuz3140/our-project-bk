import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middleware/validate.middleware';
import { rateLimit } from '../middleware/rateLimit.middleware';
import {
  RegisterSchema,
  LoginSchema,
  VerifyOtpSchema,
  ResendOtpSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  ChangePasswordSchema
} from '../shared/auth';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

// Registration with rate limiting (5 attempts per 15 minutes)
router.post('/register', rateLimit(5, 15, 'register'), validate(RegisterSchema), (req, res, next) => {
  authController.register(req, res, next);
});

// Login with rate limiting (10 attempts per 15 minutes)
router.post('/login', rateLimit(10, 15, 'login'), validate(LoginSchema), (req, res, next) => {
  authController.login(req, res, next);
});

// OTP Verification (10 attempts per 15 minutes)
router.post('/verify-otp', rateLimit(10, 15, 'verify'), validate(VerifyOtpSchema), (req, res, next) => {
  authController.verifyOtp(req, res, next);
});

// OTP Resend (3 attempts per 15 minutes)
router.post('/resend-otp', rateLimit(3, 15, 'resend'), validate(ResendOtpSchema), (req, res, next) => {
  authController.resendOtp(req, res, next);
});

// Forgot Password Request (5 attempts per 15 minutes)
router.post('/forgot-password', rateLimit(5, 15, 'forgot'), validate(ForgotPasswordSchema), (req, res, next) => {
  authController.forgotPassword(req, res, next);
});

// Password Reset with verified OTP
router.post('/reset-password', rateLimit(5, 15, 'reset'), validate(ResetPasswordSchema), (req, res, next) => {
  authController.resetPassword(req, res, next);
});

// Password Change for logged-in user
router.post('/change-password', requireAuth, validate(ChangePasswordSchema), (req, res, next) => {
  authController.changePassword(req, res, next);
});

// Logout
router.post('/logout', (req, res) => {
  authController.logout(req, res);
});

// Authenticated User Profile
router.get('/me', requireAuth, (req, res) => {
  authController.getMe(req, res);
});

// Update Profile (name, phone)
router.patch('/profile', requireAuth, (req, res, next) => {
  authController.updateProfile(req, res, next);
});

export const authRoutes = router;
