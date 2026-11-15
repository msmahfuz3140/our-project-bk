import mongoose from 'mongoose';
import { WebsiteSettingsModel, IWebsiteSettings } from '../models/WebsiteSettings';
import { UserModel } from '../models/User';
import { AuditLogModel } from '../models/AuditLog';
import { ApiError } from '../utils/apiError';
import { UserRole } from '../shared/roles';
import { logger } from '../utils/logger';

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

    if (changed) {
      await settings.save().catch(() => undefined);
    }
  }

  /**
   * Public settings for client-side branding, support, and legal policy pages
   */
  async getPublicSettings(): Promise<Partial<IWebsiteSettings>> {
    const settings = await WebsiteSettingsModel.getSettings();
    await this.migrateBranding(settings);
    return {
      siteName: settings.siteName,
      logoUrl: settings.logoUrl,
      faviconUrl: settings.faviconUrl,
      brandColors: settings.brandColors,
      supportContact: settings.supportContact,
      socialLinks: settings.socialLinks,
      homepageContent: settings.homepageContent,
      footerContent: settings.footerContent,
      faqItems: settings.faqItems,
      legalPolicies: settings.legalPolicies
    };
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
      homepageContent: settings.homepageContent
    };

    if (updates.siteName !== undefined) settings.siteName = updates.siteName.trim();
    if (updates.logoUrl !== undefined) settings.logoUrl = updates.logoUrl.trim();
    if (updates.faviconUrl !== undefined) settings.faviconUrl = updates.faviconUrl.trim();

    if (updates.brandColors) {
      settings.brandColors = {
        primary: updates.brandColors.primary?.trim() || settings.brandColors.primary,
        accent: updates.brandColors.accent?.trim() || settings.brandColors.accent,
        background: updates.brandColors.background?.trim() || settings.brandColors.background
      };
    }

    if (updates.supportContact) {
      settings.supportContact = {
        email: updates.supportContact.email !== undefined ? updates.supportContact.email.trim() : settings.supportContact.email,
        telegram: updates.supportContact.telegram !== undefined ? updates.supportContact.telegram.trim() : settings.supportContact.telegram,
        discord: updates.supportContact.discord !== undefined ? updates.supportContact.discord.trim() : settings.supportContact.discord
      };
      // Keep socialLinks.telegram in sync if updated
      if (updates.supportContact.telegram !== undefined) {
        settings.socialLinks.telegram = updates.supportContact.telegram.trim();
      }
    }

    if (updates.socialLinks) {
      settings.socialLinks = {
        twitter: updates.socialLinks.twitter !== undefined ? updates.socialLinks.twitter.trim() : settings.socialLinks.twitter,
        telegram: updates.socialLinks.telegram !== undefined ? updates.socialLinks.telegram.trim() : settings.socialLinks.telegram,
        youtube: updates.socialLinks.youtube !== undefined ? updates.socialLinks.youtube.trim() : settings.socialLinks.youtube,
        discord: updates.socialLinks.discord !== undefined ? updates.socialLinks.discord.trim() : settings.socialLinks.discord
      };
    }

    if (updates.homepageContent) {
      settings.homepageContent = {
        heroTitle: sanitizeHtmlContent(updates.homepageContent.heroTitle || settings.homepageContent.heroTitle),
        heroSubtitle: sanitizeHtmlContent(updates.homepageContent.heroSubtitle || settings.homepageContent.heroSubtitle),
        announcementBanner: sanitizeHtmlContent(updates.homepageContent.announcementBanner || '')
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
        homepageContent: settings.homepageContent
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
