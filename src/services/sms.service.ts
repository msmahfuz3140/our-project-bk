import { env } from '../config/env';
import { isProductionRuntime } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';
import { isValidE164 } from '../utils/phone';

export class SmsService {
  async sendSms(to: string, message: string): Promise<boolean> {
    if (!isValidE164(to)) {
      throw ApiError.badRequest('Phone number must be in international E.164 format (e.g. +14155552671)');
    }

    // Check if configured for Twilio SMS provider
    const twilioSid = env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID;
    const twilioAuth = env.TWILIO_AUTH_TOKEN || env.SMS_PROVIDER_API_KEY || process.env.TWILIO_AUTH_TOKEN || process.env.SMS_PROVIDER_API_KEY;
    const twilioFrom = env.TWILIO_PHONE_NUMBER || env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER;

    if (twilioSid && twilioAuth && twilioSid.trim() !== '' && twilioAuth.trim() !== '') {
      try {
        const authString = Buffer.from(`${twilioSid.trim()}:${twilioAuth.trim()}`).toString('base64');
        const params = new URLSearchParams();
        params.append('To', to);
        params.append('From', twilioFrom || '+15005550006');
        params.append('Body', message);

        const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${authString}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        if (!response.ok) {
          const errText = await response.text();
          logger.error('Twilio SMS provider returned error', new Error(errText), { to, status: response.status });
          throw ApiError.internal('Failed to dispatch SMS verification code from provider');
        }

        logger.info(`SMS successfully dispatched via Twilio to: ${to}`);
        return true;
      } catch (error) {
        logger.error(`SMS dispatch error to: ${to}`, error);
        if (isProductionRuntime) {
          throw ApiError.internal('SMS provider error. Verification code could not be sent.');
        }
      }
    }

    // Development/test-only simulation. Never log OTP content in production.
    if (!isProductionRuntime) {
      logger.info(`[SMS NOTIFICATION] (Target: ${to})`);
      logger.info(`Message: ${message}`);
      return true;
    }

    logger.warn('SMS delivery is not configured in production. No message content was logged.');
    return false;
  }

  async sendVerificationOtp(to: string, code: string): Promise<boolean> {
    const text = `[Roulette Accuracy] Your verification code is: ${code}. Valid for 10 minutes.`;
    return this.sendSms(to, text);
  }

  async sendPasswordResetOtp(to: string, code: string): Promise<boolean> {
    const text = `[Roulette Accuracy] Your password reset code is: ${code}. Valid for 10 minutes.`;
    return this.sendSms(to, text);
  }
}

export const smsService = new SmsService();

