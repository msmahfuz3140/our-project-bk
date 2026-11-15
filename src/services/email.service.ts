import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ApiError } from '../utils/apiError';

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class EmailService {
  private transporter: Transporter | null = null;

  private getTransporter(): Transporter | null {
    if (this.transporter) return this.transporter;

    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      try {
        this.transporter = nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_SECURE, // true for 465, false for 587
          auth: {
            user: env.SMTP_USER,
            pass: env.SMTP_PASS
          },
          tls: {
            rejectUnauthorized: false
          }
        });
        logger.info(`SMTP Transporter initialized for host: ${env.SMTP_HOST}:${env.SMTP_PORT}`);
        return this.transporter;
      } catch (err) {
        logger.error('Failed to initialize SMTP transporter', err);
      }
    }
    return null;
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    const { to, subject, text, html } = options;

    // 1. Try Nodemailer SMTP if configured
    const transporter = this.getTransporter();
    if (transporter && env.SMTP_USER) {
      try {
        const fromAddress = env.EMAIL_FROM || `Roulette Accuracy <${env.SMTP_USER}>`;
        const info = await transporter.sendMail({
          from: fromAddress,
          to,
          subject,
          text,
          html: html || text
        });

        logger.info(`Email successfully dispatched via SMTP to: ${to} (MessageId: ${info.messageId})`);
        return true;
      } catch (smtpErr) {
        logger.error(`SMTP delivery error sending to ${to}:`, smtpErr);
        if (env.NODE_ENV === 'production' && !env.EMAIL_PROVIDER_API_KEY) {
          throw ApiError.internal('SMTP delivery failed. Please verify email configuration.');
        }
      }
    }

    // 2. Check if configured for external API provider (e.g. Resend)
    if (env.EMAIL_PROVIDER_API_KEY && env.EMAIL_PROVIDER_API_KEY.trim() !== '') {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.EMAIL_PROVIDER_API_KEY}`
          },
          body: JSON.stringify({
            from: env.EMAIL_FROM || 'Roulette Accuracy <security@rouletteaccuracy.com>',
            to: [to],
            subject,
            text,
            html: html || text
          })
        });

        if (!response.ok) {
          const errData = await response.text();
          logger.error('Email delivery provider returned error', new Error(errData), { to, status: response.status });
          throw ApiError.internal('Failed to dispatch verification email from provider');
        }

        logger.info(`Email successfully dispatched via provider API to: ${to}`, { subject });
        return true;
      } catch (error) {
        logger.error(`Email dispatch error to: ${to}`, error);
        if (env.NODE_ENV === 'production') {
          throw ApiError.internal('Email service error. Verification code could not be sent.');
        }
      }
    }

    // 3. In development or test mode (or when SMTP credentials haven't been added yet): Safe local simulation
    logger.info(`📧 [EMAIL NOTIFICATION] (Target: ${to})`);
    logger.info(`Subject: ${subject}`);
    logger.info(`Content:\n${text}`);
    if (!env.SMTP_USER && env.NODE_ENV === 'production') {
      logger.warn('SMTP credentials not configured in production. Add SMTP_USER and SMTP_PASS in .env to dispatch live emails.');
    }
    return true;
  }

  async sendVerificationOtp(to: string, code: string, name?: string): Promise<boolean> {
    const greeting = name ? `Hello ${name},` : 'Hello,';
    const text = `${greeting}\n\nYour Roulette Accuracy account verification code is: ${code}\n\nThis code will expire in 10 minutes. If you did not request this, please ignore this email.\n\nBest regards,\nThe Roulette Accuracy Security Team`;
    const html = `
      <div style="background-color: #0c1017; color: #f8fafc; font-family: sans-serif; padding: 30px; border-radius: 12px; max-width: 500px; margin: 0 auto; border: 1px solid rgba(245,158,11,0.2);">
        <h2 style="color: #f59e0b; margin-top: 0;">Roulette Accuracy Verification</h2>
        <p>${greeting}</p>
        <p>Use the 6-digit one-time code below to verify your email address:</p>
        <div style="background-color: #161e2e; border: 1px solid rgba(255,255,255,0.1); padding: 15px; text-align: center; border-radius: 8px; margin: 20px 0;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #10b981;">${code}</span>
        </div>
        <p style="font-size: 12px; color: #94a3b8;">This code expires in 10 minutes. Do not share this code with anyone.</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject: `Your Roulette Accuracy Verification Code: ${code}`,
      text,
      html
    });
  }

  async sendPasswordResetOtp(to: string, code: string): Promise<boolean> {
    const text = `Hello,\n\nA password reset request was received for your Roulette Accuracy account.\n\nYour reset code is: ${code}\n\nThis code will expire in 10 minutes.\n\nIf you did not request a password reset, please secure your account immediately.`;
    return this.sendEmail({
      to,
      subject: `Roulette Accuracy Password Reset Code: ${code}`,
      text
    });
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
    const subject = `🎉 Congratulations! Your VIP Tool Secret Activation Code: ${secretCode}`;
    const text = `${greeting}\n\nCongratulations! Your VIP Subscription purchase has been verified and approved by administration.\n\nPlan: ${planName} (${durationDays} Days Active Access)\n\nYOUR SECRET ACTIVATION CODE:\n${secretCode}\n\nTo unlock the tool:\n1. Log in to your Roulette Accuracy account\n2. Open your Member Dashboard or Tool page\n3. Enter your Secret Code when prompted\n\nBest regards,\nThe Roulette Accuracy Team`;

    const html = `
      <div style="background-color: #06080d; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 32px; border-radius: 16px; max-width: 520px; margin: 0 auto; border: 1px solid rgba(245,158,11,0.3); box-shadow: 0 10px 30px rgba(0,0,0,0.8);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #f59e0b; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 1px;">Roulette Accuracy</h1>
          <p style="color: #94a3b8; font-size: 11px; text-transform: uppercase; margin-top: 4px; letter-spacing: 2px;">European Roulette Intelligence</p>
        </div>
        <div style="background-color: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 10px; padding: 12px 16px; margin-bottom: 20px; text-align: center;">
          <span style="color: #10b981; font-weight: bold; font-size: 13px;">✓ VIP Subscription Approved & Confirmed</span>
        </div>
        <p style="font-size: 15px; color: #f8fafc;">${greeting}</p>
        <p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">Congratulations! Your VIP Pass has been verified and approved. Your account is now granted access to the European Roulette live prediction tool.</p>
        <div style="background: linear-gradient(135deg, #0e1422, #141d30); border: 1px solid rgba(245,158,11,0.3); border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
          <span style="color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">Your Secret Activation Code</span>
          <span style="font-size: 30px; font-weight: 900; letter-spacing: 6px; color: #f59e0b; font-family: monospace; display: block;">${secretCode}</span>
          <span style="color: #64748b; font-size: 11px; display: block; margin-top: 8px;">Plan: ${planName} • Valid for ${durationDays} Days</span>
        </div>
        <p style="font-size: 13px; color: #94a3b8; line-height: 1.6;">
          <strong>How to unlock the tool:</strong><br/>
          1. Go to your <a href="http://localhost:3000/dashboard" style="color: #f59e0b; text-decoration: underline;">Member Dashboard</a> or Tool page.<br/>
          2. Enter the <strong>Secret Activation Code</strong> above in the prompt.<br/>
          3. Enjoy real-time algorithmic prediction across all 20+ live Evolution & Pragmatic tables!
        </p>
        <hr style="border: none; border-top: 1px solid rgba(255,255,255,0.08); margin: 24px 0;" />
        <p style="font-size: 11px; color: #64748b; text-align: center; margin: 0;">Do not share this Secret Code. Roulette Accuracy Security Team</p>
      </div>
    `;

    return this.sendEmail({
      to,
      subject,
      text,
      html
    });
  }
}

export const emailService = new EmailService();

