import mongoose from 'mongoose';
import { WebsiteSettingsModel, IWebsiteSettings, DEFAULT_SITE_FAQS } from '../models/WebsiteSettings';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { logger } from '../utils/logger';
import { cacheKeys, memoryCache } from '../utils/cache';

/**
 * Sanitizes rich-text and legal policy content to prevent arbitrary script and HTML injection.
 * Removes <script>, <iframe>, <object>, <embed>, javascript: links, and event attributes.
 */
export function sanitizeHtmlContent(input: string): string {
  if (!input) return '';
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, '')
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
    .replace(/\bon\w+\s*=\s*(?:["'][^"']*["']|[^\s>]+)/gi, '') // Strip inline event handlers like onerror, onload
    .replace(/javascript:[^"'\s>]+/gi, '')
    .trim();
}

function safeSettingUrl(input: string | undefined, allowRelative = true): string {
  const value = (input || '').trim();
  if (!value) return '';
  if (allowRelative && value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function safeTelegramSetting(input: string | undefined): string {
  const value = (input || '').trim();
  if (!value) return '';
  if (/^@?[A-Za-z0-9_]{4,64}$/.test(value)) return value;
  return safeSettingUrl(value, false);
}

function normalizeTelegramPaymentSupport(input: string | undefined): string {
  const value = (input || '').trim();
  if (!value) return '';
  const safe = safeTelegramSetting(value);
  if (safe) return safe;
  const match = value.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,64})/i
  );
  return match ? `https://t.me/${match[1]}` : '';
}

export class WebsiteSettingsService {
  /**
   * Migrate persisted branding left over from the old product name. This keeps
   * existing admin-authored content but replaces only the exact old brand.
   */
  private async migrateBranding(settings: IWebsiteSettings): Promise<void> {
    const replaceBrand = (value: string | undefined): string | undefined =>
      typeof value === 'string'
        ? value
            .replace(/Roulette\.tools/g, 'Roulette Accuracy')
            .replace(/Roulette Computer/g, 'Roulette Accuracy')
            .replace(/ROULETTE COMPUTER/g, 'ROULETTE ACCURACY')
        : value;

    let changed = false;
    if (settings.siteName === 'Roulette.tools' || settings.siteName === 'Roulette Computer') {
      settings.siteName = 'Roulette Accuracy';
      changed = true;
    }

    if (settings.footerContent) {
      const copyrightText = replaceBrand(settings.footerContent.copyrightText);
      const disclaimerText = replaceBrand(settings.footerContent.disclaimerText);
      if (copyrightText !== settings.footerContent.copyrightText || disclaimerText !== settings.footerContent.disclaimerText) {
        settings.footerContent.copyrightText = copyrightText || '';
        settings.footerContent.disclaimerText = disclaimerText || '';
        changed = true;
      }
    }

    if (settings.homepageContent) {
      const keys: Array<'heroTitle' | 'heroSubtitle' | 'announcementBanner'> = [
        'heroTitle',
        'heroSubtitle',
        'announcementBanner'
      ];
      for (const key of keys) {
        const next = replaceBrand(settings.homepageContent[key]);
        if (next !== settings.homepageContent[key]) {
          settings.homepageContent[key] = next || '';
          changed = true;
        }
      }
    }

    if (settings.legalPolicies) {
      const keys: Array<
        'termsAndConditions' | 'privacyPolicy' | 'subscriptionPolicy' | 'referralPolicy'
      > = ['termsAndConditions', 'privacyPolicy', 'subscriptionPolicy', 'referralPolicy'];
      for (const key of keys) {
        const next = replaceBrand(settings.legalPolicies[key]);
        if (next !== settings.legalPolicies[key]) {
          settings.legalPolicies[key] = next || '';
          changed = true;
        }
      }
    }

    if (!settings.homepageContent) {
      settings.homepageContent = {
        heroTitle: 'Read the wheel. Time the pattern.',
        heroSubtitle: 'Roulette Accuracy turns live European wheel telemetry into a clear, direction-aware precision layer.',
        announcementBanner: ''
      };
      changed = true;
    }

    if (!settings.community) {
      settings.community = {
        enabled: true,
        telegramName: 'Roulette Accuracy Official Community',
        telegramLink: 'https://t.me/roulettetools',
        description:
          'Join our official Telegram community for live table alerts, platform updates, and direct access to the Accuracy.tools team.',
        buttonText: 'Join Our Telegram Community'
      };
      changed = true;
    }

    if (!settings.paymentSettings) {
      settings.paymentSettings = {
        minPlanPriceCents: 20,
        paymentSupportEnabled: true,
        paymentSupportTelegram: ''
      };
      changed = true;
    }

    const legacyHeroTitle = 'Algorithmic Roulette Intelligence & Statistical Wheel Tracking';
    if (settings.homepageContent?.heroTitle === legacyHeroTitle) {
      settings.homepageContent.heroTitle = 'Read the wheel. Time the pattern.';
      changed = true;
    }

    const legacyFaqQuestions = [
      'How does the prediction software work?',
      'Does the software guarantee winning spins?',
      'Which cryptocurrencies are supported for subscriptions?'
    ];
    if (
      Array.isArray(settings.faqItems) &&
      settings.faqItems.length === 3 &&
      legacyFaqQuestions.every((question, index) => settings.faqItems[index]?.question === question)
    ) {
      settings.faqItems = DEFAULT_SITE_FAQS.map((item) => ({ ...item }));
      changed = true;
    }

    if (changed) {
      await settings.save().catch(() => undefined);
    }
  }

  /**
   * Public settings for client-side branding, support, and legal policy pages
   */
  async getPublicSettings(): Promise<Partial<IWebsiteSettings>> {
    return memoryCache.getOrSet(cacheKeys.publicSettings, 60, async () => {
      const settings = await WebsiteSettingsModel.getSettings();
      await this.migrateBranding(settings);
      const plain = settings.toObject();
      return {
        siteName: plain.siteName,
        logoUrl: plain.logoUrl,
        faviconUrl: plain.faviconUrl,
        brandColors: plain.brandColors,
        supportContact: plain.supportContact,
        socialLinks: plain.socialLinks,
        homepageContent: plain.homepageContent,
        community: {
          enabled: plain.community?.enabled !== false,
          telegramName:
            plain.community?.telegramName || 'Roulette Accuracy Official Community',
          telegramLink: plain.community?.telegramLink || 'https://t.me/roulettetools',
          description:
            plain.community?.description ||
            'Join our official Telegram community for live table alerts, platform updates, and direct access to the Accuracy.tools team.',
          buttonText: plain.community?.buttonText || 'Join Our Telegram Community'
        },
        paymentSettings: {
          minPlanPriceCents:
            typeof plain.paymentSettings?.minPlanPriceCents === 'number'
              ? plain.paymentSettings.minPlanPriceCents
              : 20,
          paymentSupportEnabled: plain.paymentSettings?.paymentSupportEnabled !== false,
          paymentSupportTelegram: plain.paymentSettings?.paymentSupportTelegram || ''
        },
        footerContent: plain.footerContent,
        faqItems: plain.faqItems,
        legalPolicies: plain.legalPolicies,
        updatedAt: plain.updatedAt
      };
    });
  }

  /**
   * Full settings for Main Admin panel
   */
  async getAdminSettings(): Promise<IWebsiteSettings> {
    const settings = await WebsiteSettingsModel.getSettings();
    await this.migrateBranding(settings);
    return settings;
  }

  /**
   * Payment configuration used by backend validation and the payment UI.
   */
  async getPaymentSettings(): Promise<{
    minPlanPriceCents: number;
    paymentSupportEnabled: boolean;
    paymentSupportTelegram: string;
  }> {
    try {
      const settings = await WebsiteSettingsModel.getSettings();
      const min = Number(settings.paymentSettings?.minPlanPriceCents);
      return {
        minPlanPriceCents: Number.isFinite(min) && min >= 20 ? Math.round(min) : 20,
        paymentSupportEnabled: settings.paymentSettings?.paymentSupportEnabled !== false,
        paymentSupportTelegram: settings.paymentSettings?.paymentSupportTelegram || ''
      };
    } catch {
      return {
        minPlanPriceCents: 20,
        paymentSupportEnabled: true,
        paymentSupportTelegram: ''
      };
    }
  }

  /**
   * Update website settings with sanitization and audit logging
   */
  async updateSettings(
    adminId: string,
    adminEmail: string,
    updates: Partial<IWebsiteSettings>,
    reason: string
  ): Promise<IWebsiteSettings> {
    if (!reason || reason.trim() === '') {
      throw ApiError.badRequest('Audit reason is required when modifying website content or settings');
    }

    const admin = await UserModel.findById(adminId);
    if (!admin || admin.role !== UserRole.SUPER_ADMIN) {
      throw ApiError.forbidden('Only authorized Main Admins can update website settings');
    }

    const settings = await WebsiteSettingsModel.getSettings();
    const previousSnapshot = {
      siteName: settings.siteName,
      brandColors: settings.brandColors,
      supportContact: settings.supportContact,
      homepageContent: settings.homepageContent,
      community: settings.community,
      paymentSettings: settings.paymentSettings
    };

    if (updates.siteName !== undefined) {
      const nextName = updates.siteName.trim().slice(0, 100);
      if (nextName.length >= 2) settings.siteName = nextName;
    }
    if (updates.logoUrl !== undefined) settings.logoUrl = safeSettingUrl(updates.logoUrl);
    if (updates.faviconUrl !== undefined) settings.faviconUrl = safeSettingUrl(updates.faviconUrl);

    if (updates.brandColors) {
      settings.brandColors = {
        primary: updates.brandColors.primary?.trim() || settings.brandColors.primary,
        accent: updates.brandColors.accent?.trim() || settings.brandColors.accent,
        background: updates.brandColors.background?.trim() || settings.brandColors.background
      };
    }

    if (updates.supportContact) {
      settings.supportContact = {
        email: updates.supportContact.email !== undefined ? updates.supportContact.email.trim().slice(0, 200) : settings.supportContact.email,
        telegram: updates.supportContact.telegram !== undefined ? safeTelegramSetting(updates.supportContact.telegram) : settings.supportContact.telegram,
        discord: updates.supportContact.discord !== undefined ? safeSettingUrl(updates.supportContact.discord, false) : settings.supportContact.discord
      };
      // Keep socialLinks.telegram in sync if updated
      if (updates.supportContact.telegram !== undefined) {
        settings.socialLinks.telegram = safeTelegramSetting(updates.supportContact.telegram);
      }
    }

    if (updates.socialLinks) {
      settings.socialLinks = {
        twitter: updates.socialLinks.twitter !== undefined ? safeSettingUrl(updates.socialLinks.twitter, false) : settings.socialLinks.twitter,
        telegram: updates.socialLinks.telegram !== undefined ? safeTelegramSetting(updates.socialLinks.telegram) : settings.socialLinks.telegram,
        youtube: updates.socialLinks.youtube !== undefined ? safeSettingUrl(updates.socialLinks.youtube, false) : settings.socialLinks.youtube,
        discord: updates.socialLinks.discord !== undefined ? safeSettingUrl(updates.socialLinks.discord, false) : settings.socialLinks.discord
      };
    }

    if (updates.homepageContent) {
      settings.homepageContent = {
        heroTitle: sanitizeHtmlContent(updates.homepageContent.heroTitle || settings.homepageContent.heroTitle),
        heroSubtitle: sanitizeHtmlContent(updates.homepageContent.heroSubtitle || settings.homepageContent.heroSubtitle),
        announcementBanner: sanitizeHtmlContent(updates.homepageContent.announcementBanner || '')
      };
    }

    if (updates.community) {
      const current = settings.community || ({} as IWebsiteSettings['community']);
      settings.community = {
        enabled:
          updates.community.enabled !== undefined
            ? Boolean(updates.community.enabled)
            : current.enabled !== false,
        telegramName:
          updates.community.telegramName !== undefined
            ? sanitizeHtmlContent(updates.community.telegramName).slice(0, 100)
            : current.telegramName || 'Roulette Accuracy Official Community',
        telegramLink:
          updates.community.telegramLink !== undefined
            ? (() => {
                const safe = safeTelegramSetting(updates.community.telegramLink);
                if (!safe) return '';
                if (/^https?:\/\//i.test(safe)) return safe;
                return `https://t.me/${safe.replace(/^@/, '')}`;
              })()
            : current.telegramLink || '',
        description:
          updates.community.description !== undefined
            ? sanitizeHtmlContent(updates.community.description).slice(0, 600)
            : current.description || '',
        buttonText:
          updates.community.buttonText !== undefined
            ? sanitizeHtmlContent(updates.community.buttonText).slice(0, 60)
            : current.buttonText || 'Join Our Telegram Community'
      };
    }

    if (updates.paymentSettings) {
      const current = settings.paymentSettings || ({} as IWebsiteSettings['paymentSettings']);
      const rawMin = Number(updates.paymentSettings.minPlanPriceCents);
      settings.paymentSettings = {
        minPlanPriceCents:
          Number.isFinite(rawMin) && rawMin >= 20
            ? Math.round(rawMin)
            : current.minPlanPriceCents || 20,
        paymentSupportEnabled:
          updates.paymentSettings.paymentSupportEnabled !== undefined
            ? Boolean(updates.paymentSettings.paymentSupportEnabled)
            : current.paymentSupportEnabled !== false,
        paymentSupportTelegram:
          updates.paymentSettings.paymentSupportTelegram !== undefined
            ? normalizeTelegramPaymentSupport(updates.paymentSettings.paymentSupportTelegram)
            : current.paymentSupportTelegram || ''
      };
    }

    if (updates.footerContent) {
      settings.footerContent = {
        copyrightText: sanitizeHtmlContent(updates.footerContent.copyrightText || settings.footerContent.copyrightText),
        disclaimerText: sanitizeHtmlContent(updates.footerContent.disclaimerText || settings.footerContent.disclaimerText)
      };
    }

    if (updates.faqItems && Array.isArray(updates.faqItems)) {
      settings.faqItems = updates.faqItems.map((item, idx) => ({
        question: sanitizeHtmlContent(item.question),
        answer: sanitizeHtmlContent(item.answer),
        category: sanitizeHtmlContent(item.category || 'Platform').slice(0, 60),
        order: item.order !== undefined ? item.order : idx + 1
      }));
    }

    if (updates.legalPolicies) {
      settings.legalPolicies = {
        termsAndConditions: sanitizeHtmlContent(updates.legalPolicies.termsAndConditions || settings.legalPolicies.termsAndConditions),
        privacyPolicy: sanitizeHtmlContent(updates.legalPolicies.privacyPolicy || settings.legalPolicies.privacyPolicy),
        subscriptionPolicy: sanitizeHtmlContent(updates.legalPolicies.subscriptionPolicy || settings.legalPolicies.subscriptionPolicy),
        referralPolicy: sanitizeHtmlContent(updates.legalPolicies.referralPolicy || settings.legalPolicies.referralPolicy)
      };
    }

    settings.updatedByAdminId = new mongoose.Types.ObjectId(adminId);
    settings.updatedByAdminEmail = adminEmail;
    await settings.save();
    memoryCache.del(cacheKeys.publicSettings);

    await AuditLogModel.create({
      action: 'WEBSITE_SETTINGS_UPDATE',
      adminId: new mongoose.Types.ObjectId(adminId),
      adminEmail,
      reason: reason.trim(),
      previousValue: previousSnapshot,
      newValue: {
        siteName: settings.siteName,
        brandColors: settings.brandColors,
        supportContact: settings.supportContact,
        homepageContent: settings.homepageContent,
        community: settings.community,
        paymentSettings: settings.paymentSettings
      },
      details: {
        sanitized: true,
        note: 'All rich content fields verified and sanitized against script injection.'
      }
    });

    logger.info(`Main Admin ${adminEmail} updated website settings. Reason: ${reason}`);

    return settings;
  }
}

export const websiteSettingsService = new WebsiteSettingsService();
