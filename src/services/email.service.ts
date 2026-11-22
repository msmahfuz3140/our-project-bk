import nodemailer, { Transporter } from 'nodemailer';
import { env, isProductionRuntime, isEmailTransportConfigured } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';
import { verificationOtp, passwordResetOtp, escapeHtml } from './emailTemplates';

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const PLACEHOLDER_PATTERN = /^(user|pass|password|your[_-]?|changeme|replace)/i;

function isUsableCredential(value?: string): boolean {
  const clean = (value || '').trim();
  return clean.length > 0 && !PLACEHOLDER_PATTERN.test(clean);
}

export class EmailService {
  private transporter: Transporter | null = null;
  private warnedMissingTransport = false;

  get isConfigured(): boolean {
    return isEmailTransportConfigured();
  }

  private getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter;

    const host = (env.SMTP_HOST || '').trim();
    const user = (env.SMTP_USER || '').trim();
    const pass = (env.SMTP_PASS || '').trim();

    if (host && isUsableCredential(user) && isUsableCredential(pass)) {
      try {
        this.transporter = nodemailer.createTransport({
          host,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE, // true for 465, false for 587/STARTTLS
          auth: { user, pass },
          // Never accept invalid TLS certificates for a production mail server.
          tls: { rejectUnauthorized: isProductionRuntime }
        });
        logger.info('SMTP transporter initialized', {
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE
        });
        return this.transporter;
      } catch (error) {
        logger.error('Failed to initialize SMTP transporter', error);
      }
    }
    return null;
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    const { to, subject, text, html } = options;
    const recipient = String(to || '').trim();
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      logger.warn('Transactional email skipped: invalid recipient address');
      return false;
    }

    // 1. Primary transport: SMTP via Nodemailer.
    const transporter = this.getTransporter();
    if (transporter) {
      try {
        const info = await transporter.sendMail({
          from: env.EMAIL_SENDER,
          to: recipient,
          subject,
          text,
          html: html || text
        });
        logger.info('Email delivered via SMTP', {
          to: recipient,
          subject,
          messageId: info.messageId
        });
        return true;
      } catch (error: any) {
        logger.error('SMTP delivery error', {
          to: recipient,
          subject,
          error: error?.message
        });
        // Fall through to the optional provider API. In production a failure is
        // surfaced to the caller so it can be recorded and retried.
        if (isProductionRuntime && !env.EMAIL_PROVIDER_API_KEY) {
          throw ApiError.internal('Email delivery failed. Please verify SMTP configuration.');
        }
      }
    }

    // 2. Optional HTTPS email provider (Resend-compatible API).
    if (env.EMAIL_PROVIDER_API_KEY && env.EMAIL_PROVIDER_API_KEY.trim() !== '') {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.EMAIL_PROVIDER_API_KEY}`
          },
          body: JSON.stringify({
            from: env.EMAIL_SENDER,
            to: [recipient],
            subject,
            text,
            html: html || text
          })
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Email provider returned ${response.status}: ${body.slice(0, 300)}`);
        }

        logger.info('Email delivered via provider API', { to: recipient, subject });
        return true;
      } catch (error: any) {
        logger.error('Email provider delivery error', {
          to: recipient,
          subject,
          error: error?.message
        });
        if (isProductionRuntime) {
          throw ApiError.internal('Email service error. The message could not be delivered.');
        }
      }
    }

    // 3. Test-only simulation. OTP values are never printed, even locally.
    if (env.NODE_ENV === 'test') {
      logger.debug('Email transport simulated in test environment', { to: recipient, subject });
      return true;
    }

    if (!this.warnedMissingTransport) {
      this.warnedMissingTransport = true;
      logger.warn(
        'Transactional email transport is not configured. Configure SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS and SMTP_FROM_EMAIL (or EMAIL_PROVIDER_API_KEY).'
      );
    }
    return false;
  }

  async sendVerificationOtp(
    to: string,
    code: string,
    options: { name?: string; expiryMinutes?: number; siteUrl?: string } = {}
  ): Promise<boolean> {
    const rendered = verificationOtp({
      name: options.name,
      code,
      expiryMinutes: options.expiryMinutes ?? env.OTP_EXPIRY_MINUTES,
      siteUrl: options.siteUrl || env.PUBLIC_FRONTEND_URL
    });
    return this.sendEmail({ to, ...rendered });
  }

  async sendPasswordResetOtp(to: string, code: string, expiryMinutes = env.OTP_EXPIRY_MINUTES): Promise<boolean> {
    const rendered = passwordResetOtp({
      code,
      expiryMinutes,
      siteUrl: env.PUBLIC_FRONTEND_URL
    });
    return this.sendEmail({ to, ...rendered });
  }

  async sendVipSecretCodeEmail(options: {
    to: string;
    name: string;
    planName: string;
    durationDays: number;
    secretCode: string;
  }): Promise<boolean> {
    const { to, name, planName, durationDays, secretCode } = options;
    const greeting = name ? `Hello ${name},` : 'Hello,';
    const subject = 'Your VIP plan is active — Roulette Accuracy';
    const text = `${greeting}

Congratulations! Your VIP subscription purchase has been verified and approved.

Plan: ${planName} (${durationDays} Days Active Access)

YOUR SECRET ACTIVATION CODE:
${secretCode}

To unlock the tool:
1. Log in to your Roulette Accuracy account
2. Open your Member Dashboard or Tool page
3. Enter your Secret Code when prompted

Best regards,
The Roulette Accuracy Team`;

    const html = `
      <div style="background-color:#06080d;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:32px;border-radius:16px;max-width:520px;margin:0 auto;border:1px solid rgba(245,158,11,0.3);">
        <div style="text-align:center;margin-bottom:24px;">
          <h1 style="color:#f59e0b;margin:0;font-size:24px;font-weight:800;letter-spacing:1px;">Roulette Accuracy</h1>
          <p style="color:#94a3b8;font-size:11px;text-transform:uppercase;margin-top:4px;letter-spacing:2px;">European Roulette Intelligence</p>
        </div>
        <p style="font-size:15px;color:#f8fafc;">${escapeHtml(greeting)}</p>
        <p style="font-size:14px;color:#cbd5e1;line-height:1.6;">Your VIP plan has been verified and approved.</p>
        <div style="background:#0e1422;border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:20px;text-align:center;margin:24px 0;">
          <span style="color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;display:block;margin-bottom:8px;">Your Secret Activation Code</span>
          <span style="font-size:30px;font-weight:900;letter-spacing:6px;color:#f59e0b;font-family:monospace;display:block;">${escapeHtml(secretCode)}</span>
          <span style="color:#64748b;font-size:11px;display:block;margin-top:8px;">Plan: ${escapeHtml(planName)} • Valid for ${escapeHtml(String(durationDays))} Days</span>
        </div>
        <p style="font-size:13px;color:#94a3b8;line-height:1.6;">Open your member dashboard and enter the code when prompted. Do not share this code with anyone.</p>
      </div>
    `;

    return this.sendEmail({ to, subject, text, html });
  }
}

export const emailService = new EmailService();
