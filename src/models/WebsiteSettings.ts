import mongoose, { Schema, Document } from 'mongoose';

export interface IFaqItem {
  question: string;
  answer: string;
  order: number;
}

export interface IWebsiteSettings extends Document {
  siteName: string;
  logoUrl: string;
  faviconUrl: string;
  brandColors: {
    primary: string;
    accent: string;
    background: string;
  };
  supportContact: {
    email: string;
    telegram: string;
    discord: string;
  };
  socialLinks: {
    twitter: string;
    telegram: string;
    youtube: string;
    discord: string;
  };
  homepageContent: {
    heroTitle: string;
    heroSubtitle: string;
    announcementBanner: string;
  };
  footerContent: {
    copyrightText: string;
    disclaimerText: string;
  };
  faqItems: IFaqItem[];
  legalPolicies: {
    termsAndConditions: string;
    privacyPolicy: string;
    subscriptionPolicy: string;
    referralPolicy: string;
  };
  updatedByAdminId?: mongoose.Types.ObjectId;
  updatedByAdminEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWebsiteSettingsModel extends mongoose.Model<IWebsiteSettings> {
  getSettings(): Promise<IWebsiteSettings>;
}

const FaqItemSchema = new Schema<IFaqItem>({
  question: { type: String, required: true },
  answer: { type: String, required: true },
  order: { type: Number, default: 0 }
});

const WebsiteSettingsSchema = new Schema<IWebsiteSettings>(
  {
    siteName: {
      type: String,
      default: 'Roulette Accuracy'
    },
    logoUrl: {
      type: String,
      default: '/logo.png'
    },
    faviconUrl: {
      type: String,
      default: '/favicon.ico'
    },
    brandColors: {
      primary: { type: String, default: '#f59e0b' },
      accent: { type: String, default: '#10b981' },
      background: { type: String, default: '#06080d' }
    },
    supportContact: {
      email: { type: String, default: 'support@rouletteaccuracy.com' },
      telegram: { type: String, default: 'https://t.me/roulettetools_support' },
      discord: { type: String, default: '' }
    },
    socialLinks: {
      twitter: { type: String, default: 'https://x.com/roulettetools' },
      telegram: { type: String, default: 'https://t.me/roulettetools' },
      youtube: { type: String, default: '' },
      discord: { type: String, default: '' }
    },
    homepageContent: {
      heroTitle: { type: String, default: 'Algorithmic Roulette Intelligence & Statistical Wheel Tracking' },
      heroSubtitle: { type: String, default: 'Real-time telemetry and pattern identification for European Roulette live tables. Professional grade SaaS analytics.' },
      announcementBanner: { type: String, default: '' }
    },
    footerContent: {
      copyrightText: { type: String, default: '© 2026 Roulette Accuracy. All rights reserved.' },
      disclaimerText: { type: String, default: 'Roulette Accuracy is an analytical SaaS tool. We do not accept bets or operate gaming services.' }
    },
    faqItems: {
      type: [FaqItemSchema],
      default: [
        {
          question: 'How does the prediction software work?',
          answer: 'The platform ingests live wheel telemetry and calculates sector probabilities based on physical wheel biases, dealer signature deviations, and offset patterns on European single-zero wheels.',
          order: 1
        },
        {
          question: 'Does the software guarantee winning spins?',
          answer: 'No. European Roulette retains an inherent 2.70% house edge. Our software delivers mathematical edge identification, not absolute outcome prediction.',
          order: 2
        },
        {
          question: 'Which cryptocurrencies are supported for subscriptions?',
          answer: 'We accept USDT (TRC-20, ERC-20, BEP-20), BTC, ETH, TRX, LTC, SOL, DOGE, and USDC via NOWPayments gateway.',
          order: 3
        }
      ]
    },
    legalPolicies: {
      termsAndConditions: { type: String, default: '' },
      privacyPolicy: { type: String, default: '' },
      subscriptionPolicy: { type: String, default: '' },
      referralPolicy: { type: String, default: '' }
    },
    updatedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    updatedByAdminEmail: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

WebsiteSettingsSchema.statics.getSettings = async function (): Promise<IWebsiteSettings> {
  let doc = await this.findOne();
  if (!doc) {
    doc = await this.create({});
  }
  return doc;
};

export const WebsiteSettingsModel =
  (mongoose.models.WebsiteSettings as IWebsiteSettingsModel) ||
  mongoose.model<IWebsiteSettings, IWebsiteSettingsModel>('WebsiteSettings', WebsiteSettingsSchema);

