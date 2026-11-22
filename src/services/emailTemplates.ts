/**
 * Branded, email-client-compatible transactional templates.
 *
 * Rules:
 * - Table-based layout with inline CSS only.
 * - No JavaScript, no external images and no remote fonts.
 * - Every message has a readable plain-text fallback.
 * - All user-provided values are HTML-escaped.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND = 'Roulette Accuracy';
const BRAND_URL = 'https://rouletteaccuracy.com';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatUsd(value: number): string {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `$${safe.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function formatDateTime(value: Date | string | undefined): string {
  if (!value) return 'Not applicable';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not applicable';
  return `${date.toUTCString()}`;
}

export function maskWalletAddress(address: string): string {
  const clean = String(address || '').trim();
  if (clean.length <= 12) return '••••••••';
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

function layout(options: {
  preheader: string;
  heading: string;
  accent?: string;
  bodyHtml: string;
}): string {
  const accent = options.accent || '#f59e0b';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(options.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#eef1f6;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(options.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#eef1f6;padding:28px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:580px;background-color:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 12px 40px rgba(15,23,42,0.08);">
          <tr>
            <td style="background-color:#080c14;padding:24px 30px;border-bottom:3px solid ${accent};">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-family:Georgia,'Times New Roman',serif;font-size:21px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">
                    ROULETTE <span style="color:${accent};">ACCURACY</span>
                  </td>
                  <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#8290a6;">
                    European Roulette Intelligence
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:34px 30px 10px 30px;">
              <h1 style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:23px;line-height:1.25;color:#0f172a;">${escapeHtml(options.heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 30px 30px 30px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.65;color:#334155;">
              ${options.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 30px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#64748b;">
              <p style="margin:0 0 6px 0;">This is an automated message from ${BRAND}. Please do not reply directly to this email.</p>
              <p style="margin:0;">Need help? Visit <a href="${BRAND_URL}/contact" style="color:#b45309;text-decoration:underline;">${BRAND_URL}/contact</a>.</p>
            </td>
          </tr>
        </table>
        <p style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:#94a3b8;margin:16px 0 0 0;">&copy; ${new Date().getUTCFullYear()} ${BRAND}. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function button(label: string, url: string, accent = '#f59e0b'): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
    <tr>
      <td align="center" style="border-radius:10px;background-color:${accent};">
        <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 22px;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#0b0f17;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function detailTable(rows: Array<{ label: string; value: string }>): string {
  const body = rows
    .map(
      (row) => `<tr>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#64748b;vertical-align:top;width:44%;">${escapeHtml(row.label)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #eef2f7;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;color:#0f172a;text-align:right;vertical-align:top;word-break:break-word;">${escapeHtml(row.value)}</td>
      </tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:18px 0;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:6px 16px;">${body}</table>`;
}

export function verificationOtp(options: {
  name?: string;
  code: string;
  expiryMinutes: number;
  siteUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Verify your email — Roulette Accuracy';
  const heading = 'Verify Your Email';

  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">Use the verification code below to confirm your email address and activate your ${BRAND} account.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0;background-color:#0b1220;border-radius:14px;">
      <tr>
        <td align="center" style="padding:24px 16px;">
          <p style="margin:0 0 8px 0;font-family:Arial,Helvetica,sans-serif;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Your verification code</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:9px;color:#fbbf24;">${escapeHtml(options.code)}</p>
          <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#cbd5e1;">Expires in ${escapeHtml(String(options.expiryMinutes))} minutes</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 10px 0;">You received this email because an account was created for this address. If you did not create it, you can safely ignore this message.</p>
    <p style="margin:0;padding:12px 14px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:12px;color:#92400e;"><strong>Never share this code.</strong> ${BRAND} staff will never ask you for a verification code.</p>
    ${button('Open the verification page', `${options.siteUrl.replace(/\/$/, '')}/verify-otp`, '#f59e0b')}
  `;

  const text = `${greeting}

Your ${BRAND} email verification code is: ${options.code}

This code expires in ${options.expiryMinutes} minutes. Never share this code with anyone. ${BRAND} staff will never ask for it.

You received this email because an account was created for this address. If you did not create it, ignore this message.

Verification page: ${options.siteUrl.replace(/\/$/, '')}/verify-otp
`;

  return {
    subject,
    html: layout({ preheader: `Your verification code expires in ${options.expiryMinutes} minutes.`, heading, bodyHtml, accent: '#f59e0b' }),
    text
  };
}

export function passwordResetOtp(options: {
  code: string;
  expiryMinutes: number;
  siteUrl: string;
}): RenderedEmail {
  const subject = 'Reset your password — Roulette Accuracy';
  const heading = 'Password Reset Code';
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">A password reset was requested for your ${BRAND} account.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:22px 0;background-color:#0b1220;border-radius:14px;">
      <tr>
        <td align="center" style="padding:24px 16px;">
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:700;letter-spacing:9px;color:#34d399;">${escapeHtml(options.code)}</p>
          <p style="margin:10px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#cbd5e1;">Expires in ${escapeHtml(String(options.expiryMinutes))} minutes</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 10px 0;">Enter this code on the password reset page. If you did not request a reset, secure your account and contact support immediately.</p>
    <p style="margin:0;padding:12px 14px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:12px;color:#92400e;"><strong>Never share this code.</strong></p>
    ${button('Reset your password', `${options.siteUrl.replace(/\/$/, '')}/forgot-password`, '#10b981')}
  `;
  return {
    subject,
    html: layout({ preheader: 'Your password reset code is inside.', heading, bodyHtml, accent: '#10b981' }),
    text: `A password reset was requested for your ${BRAND} account.

Your reset code is: ${options.code}

This code expires in ${options.expiryMinutes} minutes. Never share it with anyone.

Reset page: ${options.siteUrl.replace(/\/$/, '')}/forgot-password

If you did not request a password reset, secure your account immediately.
`
  };
}

export function paymentSuccess(options: {
  name?: string;
  planName: string;
  amountUsd: number;
  currency: string;
  reference: string;
  activatedAt: Date | string;
  expiresAt?: Date | string;
  dashboardUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Payment Successful — Your Plan Is Active';
  const heading = 'Payment Successful — Your Plan Is Active';
  const details = detailTable([
    { label: 'Plan', value: options.planName },
    { label: 'Amount', value: `${formatUsd(options.amountUsd)} ${options.currency}` },
    { label: 'Payment reference', value: options.reference },
    { label: 'Activated at (UTC)', value: formatDateTime(options.activatedAt) },
    ...(options.expiresAt ? [{ label: 'Access expires (UTC)', value: formatDateTime(options.expiresAt) }] : [])
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">Your payment has been verified and your plan is now active. You can access the member dashboard and live tools immediately.</p>
    ${details}
    <p style="margin:0;">Keep this email as your payment confirmation. If anything looks incorrect, contact support with the reference above.</p>
    ${button('Open Member Dashboard', options.dashboardUrl, '#10b981')}
  `;
  const text = `${greeting}

Your payment has been verified and your plan is active.

Plan: ${options.planName}
Amount: ${formatUsd(options.amountUsd)} ${options.currency}
Payment reference: ${options.reference}
Activated at (UTC): ${formatDateTime(options.activatedAt)}${options.expiresAt ? `\nAccess expires (UTC): ${formatDateTime(options.expiresAt)}` : ''}

Member dashboard: ${options.dashboardUrl}

Keep this email as your payment confirmation.
`;
  return { subject, html: layout({ preheader: 'Your payment is verified and your plan is active.', heading, bodyHtml, accent: '#10b981' }), text };
}

export function accountStatus(options: {
  name?: string;
  status: 'BANNED' | 'SUSPENDED' | 'RESTORED';
  effectiveAt: Date | string;
  reason?: string;
  suspendedUntil?: Date | string;
  supportUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const isRestored = options.status === 'RESTORED';
  const subject = isRestored
    ? 'Your Roulette Accuracy account has been restored'
    : options.status === 'BANNED'
      ? 'Important: Your Roulette Accuracy account has been banned'
      : 'Important: Your Roulette Accuracy account has been suspended';
  const heading = isRestored
    ? 'Your Account Has Been Restored'
    : options.status === 'BANNED'
      ? 'Your Account Has Been Banned'
      : 'Your Account Has Been Suspended';
  const summary = isRestored
    ? 'Your account access has been restored. You can sign in again.'
    : options.status === 'BANNED'
      ? 'Your account has been banned. Access to the platform has been withdrawn.'
      : 'Your account has been temporarily suspended. Access is paused until the suspension ends.';

  const details = detailTable([
    { label: 'Status', value: isRestored ? 'Restored / Active' : options.status === 'BANNED' ? 'Banned' : 'Suspended' },
    { label: 'Effective at (UTC)', value: formatDateTime(options.effectiveAt) },
    ...(options.suspendedUntil ? [{ label: 'Suspension ends (UTC)', value: formatDateTime(options.suspendedUntil) }] : []),
    ...(options.reason && options.reason.trim() ? [{ label: 'Reason', value: options.reason.trim() }] : [])
  ]);

  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">${escapeHtml(summary)}</p>
    ${details}
    <p style="margin:0 0 14px 0;">If you believe this action was taken in error, contact our support team and include the email address registered on your account.</p>
    ${button('Contact Support', options.supportUrl, isRestored ? '#10b981' : '#ef4444')}
  `;
  const text = `${greeting}

${summary}

${isRestored ? '' : `Reason: ${options.reason || 'Not provided'}\n`}Effective at (UTC): ${formatDateTime(options.effectiveAt)}${options.suspendedUntil ? `\nSuspension ends (UTC): ${formatDateTime(options.suspendedUntil)}` : ''}

If you believe this was an error, contact support: ${options.supportUrl}
`;
  return { subject, html: layout({ preheader: summary, heading, bodyHtml, accent: isRestored ? '#10b981' : '#ef4444' }), text };
}

export function withdrawalSubmitted(options: {
  name?: string;
  amountUsd: number;
  currency: string;
  network: string;
  address: string;
  requestId: string;
  walletUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Withdrawal Request Received — Pending Review';
  const heading = 'Withdrawal Request Received';
  const details = detailTable([
    { label: 'Amount', value: formatUsd(options.amountUsd) },
    { label: 'Cryptocurrency', value: options.currency },
    { label: 'Network', value: options.network },
    { label: 'Destination (masked)', value: maskWalletAddress(options.address) },
    { label: 'Request ID', value: options.requestId },
    { label: 'Status', value: 'Pending admin review' }
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">We received your withdrawal request. The requested amount has been reserved from your available wallet balance and is now waiting for administrator review.</p>
    ${details}
    <p style="margin:0;">No payment has been sent yet. You will receive another email when the request is approved, paid, or rejected.</p>
    ${button('View My Wallet', options.walletUrl, '#f59e0b')}
  `;
  const text = `${greeting}

We received your withdrawal request. The amount is reserved and pending admin review.

Amount: ${formatUsd(options.amountUsd)}
Cryptocurrency: ${options.currency}
Network: ${options.network}
Destination (masked): ${maskWalletAddress(options.address)}
Request ID: ${options.requestId}
Status: Pending admin review

No payment has been sent yet. View your wallet: ${options.walletUrl}
`;
  return { subject, html: layout({ preheader: 'Your withdrawal request is pending admin review.', heading, bodyHtml, accent: '#f59e0b' }), text };
}

export function withdrawalApproved(options: {
  name?: string;
  amountUsd: number;
  currency: string;
  network: string;
  requestId: string;
  walletUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Withdrawal Approved — Payment Pending';
  const heading = 'Withdrawal Approved';
  const details = detailTable([
    { label: 'Amount', value: formatUsd(options.amountUsd) },
    { label: 'Cryptocurrency', value: options.currency },
    { label: 'Network', value: options.network },
    { label: 'Request ID', value: options.requestId },
    { label: 'Status', value: 'Approved — awaiting transfer' }
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">Your withdrawal request has been approved by an administrator. The amount remains reserved in your wallet while the payout is prepared.</p>
    ${details}
    <p style="margin:0;"><strong>Payment has not been sent yet.</strong> You will receive a separate confirmation once the transfer is completed.</p>
    ${button('View My Wallet', options.walletUrl, '#0ea5e9')}
  `;
  const text = `${greeting}

Your withdrawal request has been approved. Payment has NOT been sent yet.

Amount: ${formatUsd(options.amountUsd)}
Cryptocurrency: ${options.currency}
Network: ${options.network}
Request ID: ${options.requestId}
Status: Approved — awaiting transfer

View your wallet: ${options.walletUrl}
`;
  return { subject, html: layout({ preheader: 'Your withdrawal was approved and is awaiting transfer.', heading, bodyHtml, accent: '#0ea5e9' }), text };
}

export function withdrawalPaid(options: {
  name?: string;
  amountUsd: number;
  currency: string;
  network: string;
  requestId: string;
  transactionHash?: string;
  completedAt: Date | string;
  walletUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Withdrawal Sent — Payment Completed';
  const heading = 'Withdrawal Sent';
  const details = detailTable([
    { label: 'Amount', value: formatUsd(options.amountUsd) },
    { label: 'Cryptocurrency', value: options.currency },
    { label: 'Network', value: options.network },
    { label: 'Request ID', value: options.requestId },
    ...(options.transactionHash ? [{ label: 'Transaction hash', value: options.transactionHash }] : []),
    { label: 'Completed at (UTC)', value: formatDateTime(options.completedAt) }
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">Your withdrawal has been sent to the destination wallet you provided. The reserved amount is now recorded as withdrawn.</p>
    ${details}
    <p style="margin:0;">Blockchain confirmations can take additional time. Keep this email for your records.</p>
    ${button('View My Wallet', options.walletUrl, '#10b981')}
  `;
  const text = `${greeting}

Your withdrawal has been sent.

Amount: ${formatUsd(options.amountUsd)}
Cryptocurrency: ${options.currency}
Network: ${options.network}
Request ID: ${options.requestId}${options.transactionHash ? `\nTransaction hash: ${options.transactionHash}` : ''}
Completed at (UTC): ${formatDateTime(options.completedAt)}

View your wallet: ${options.walletUrl}
`;
  return { subject, html: layout({ preheader: 'Your withdrawal payment has been completed.', heading, bodyHtml, accent: '#10b981' }), text };
}

export function withdrawalRejected(options: {
  name?: string;
  amountUsd: number;
  currency: string;
  network: string;
  requestId: string;
  reason: string;
  walletUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = 'Withdrawal Request Rejected — Amount Refunded';
  const heading = 'Withdrawal Request Rejected';
  const details = detailTable([
    { label: 'Amount', value: formatUsd(options.amountUsd) },
    { label: 'Cryptocurrency', value: options.currency },
    { label: 'Network', value: options.network },
    { label: 'Request ID', value: options.requestId },
    { label: 'Reason', value: options.reason }
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">Your withdrawal request was rejected. The reserved amount has been returned to your available wallet balance.</p>
    ${details}
    <p style="margin:0;">You can review your wallet and submit a new request once the issue is resolved. If you need help, contact support.</p>
    ${button('View My Wallet', options.walletUrl, '#ef4444')}
  `;
  const text = `${greeting}

Your withdrawal request was rejected. The reserved amount has been refunded to your available wallet balance.

Amount: ${formatUsd(options.amountUsd)}
Cryptocurrency: ${options.currency}
Network: ${options.network}
Request ID: ${options.requestId}
Reason: ${options.reason}

View your wallet: ${options.walletUrl}
`;
  return { subject, html: layout({ preheader: 'Your withdrawal request was rejected and refunded.', heading, bodyHtml, accent: '#ef4444' }), text };
}

export function adminSecurityNotice(options: {
  name?: string;
  title: string;
  message: string;
  occurredAt: Date | string;
  supportUrl: string;
}): RenderedEmail {
  const name = options.name?.trim();
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const subject = `${options.title} — Roulette Accuracy Admin Security`;
  const details = detailTable([
    { label: 'Event', value: options.title },
    { label: 'Time (UTC)', value: formatDateTime(options.occurredAt) }
  ]);
  const bodyHtml = `
    <p style="margin:0 0 14px 0;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 14px 0;">${escapeHtml(options.message)}</p>
    ${details}
    <p style="margin:0;padding:12px 14px;background-color:#fef2f2;border:1px solid #fecaca;border-radius:10px;font-size:12px;color:#991b1b;">
      If you did not perform this action, contact the platform owner immediately and review your admin account security.
    </p>
    ${button('Contact Support', options.supportUrl, '#ef4444')}
  `;
  const text = `${greeting}

${options.message}

Event: ${options.title}
Time (UTC): ${formatDateTime(options.occurredAt)}

If you did not perform this action, contact the platform owner immediately.

Support: ${options.supportUrl}
`;
  return {
    subject,
    html: layout({ preheader: options.title, heading: options.title, bodyHtml, accent: '#ef4444' }),
    text
  };
}
