import mongoose, { Schema, Document } from 'mongoose';

export interface IFaqItem {
  question: string;
  answer: string;
  category?: string;
  order: number;
}

export const DEFAULT_SITE_FAQS: IFaqItem[] = [
  {
    question: 'How does the prediction software work?',
    answer: 'The platform ingests live wheel telemetry and calculates sector probabilities based on physical wheel biases, dealer signature deviations, and offset patterns on European single-zero wheels.',
    category: 'Platform',
    order: 1
  },
  {
    question: 'Does the software guarantee winning spins?',
    answer: 'No. European Roulette retains an inherent 2.70% house edge. Our software delivers mathematical edge identification, not absolute outcome prediction.',
    category: 'Platform',
    order: 2
  },
  {
    question: 'Which cryptocurrencies are supported for subscriptions?',
    answer: 'We accept USDT (TRC-20, ERC-20, BEP-20), BTC, ETH, TRX, LTC, SOL, DOGE, and USDC via the NOWPayments gateway. Premium activates only after the signed IPN reaches final settlement.',
    category: 'Payments',
    order: 3
  },
  {
    question: 'How fast does my subscription activate after payment?',
    answer: 'Subscriptions are activated automatically after the NOWPayments signed IPN reaches the final finished state and the backend independently verifies the payment. Blockchain confirmation alone does not unlock Premium.',
    category: 'Payments',
    order: 4
  },
  {
    question: 'How does the Moderator referral commission work?',
    answer: 'Approved Moderators receive unique referral links. When a referred user purchases a plan, the backend records a 50% commission ledger entry. Referral attribution is server-validated and duplicate commission records are prevented.',
    category: 'Referrals',
    order: 5
  },
  {
    question: 'Does the platform offer gambling or withdrawals?',
    answer: 'No gambling or betting mechanic is offered. The platform does not hold customer stakes or player balances. Referral commission earnings are tracked in a separate wallet and may be withdrawn through the admin-reviewed payout workflow.',
    category: 'Platform',
    order: 6
  },
  {
    question: 'How is subscription expiration calculated?',
    answer: 'Monthly and annual plans use UTC calendar-month mathematics. For example, January 31 plus one month ends on February 28, or February 29 in a leap year. Renewals extend from the existing paid-through date so no days are lost.',
    category: 'Subscriptions',
    order: 7
  },
  {
    question: 'Can I test the platform before buying a longer plan?',
    answer: 'The 15 Days Pass provides full live table access for 15 calendar days. It is the lowest-commitment way to evaluate the prediction terminal.',
    category: 'Subscriptions',
    order: 8
  }
];


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
  community: {
    enabled: boolean;
    telegramName: string;
    telegramLink: string;
    description: string;
    buttonText: string;
  };
  paymentSettings: {
    minPlanPriceCents: number;
    paymentSupportEnabled: boolean;
    paymentSupportTelegram: string;
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
  category: { type: String, default: 'Platform', trim: true, maxlength: 60 },
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
      email: { type: String, default: 'support@accuracy.tools' },
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
      heroTitle: { type: String, default: 'Read the wheel. Time the pattern.' },
      heroSubtitle: { type: String, default: 'Roulette Accuracy turns live European wheel telemetry into a clear, direction-aware precision layer — dealer rhythm, n9 sector mapping and travel mathematics in one place.' },
      announcementBanner: { type: String, default: '' }
    },
    community: {
      enabled: { type: Boolean, default: true },
      telegramName: { type: String, default: 'Roulette Accuracy Official Community', trim: true, maxlength: 100 },
      telegramLink: { type: String, default: 'https://t.me/roulettetools', trim: true, maxlength: 300 },
      description: {
        type: String,
        default: 'Join our official Telegram community for live table alerts, platform updates, and direct access to the Accuracy.tools team.',
        trim: true,
        maxlength: 600
      },
      buttonText: { type: String, default: 'Join Our Telegram Community', trim: true, maxlength: 60 }
    },
    paymentSettings: {
      minPlanPriceCents: { type: Number, default: 20, min: 20, max: 10_000_000 },
      paymentSupportEnabled: { type: Boolean, default: true },
      paymentSupportTelegram: { type: String, default: '', trim: true, maxlength: 300 }
    },
    footerContent: {
      copyrightText: { type: String, default: '© 2026 Roulette Accuracy. All rights reserved.' },
      disclaimerText: { type: String, default: 'Roulette Accuracy is an analytical SaaS tool. We do not accept bets or operate gaming services.' }
    },
    faqItems: {
      type: [FaqItemSchema],
      default: DEFAULT_SITE_FAQS
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

