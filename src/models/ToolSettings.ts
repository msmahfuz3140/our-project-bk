import mongoose, { Schema, Document } from 'mongoose';

export type ToolAccessPolicy = 'PREMIUM_ONLY' | 'OPEN_BETA' | 'MAINTENANCE';

export interface IToolSettings extends Document {
  isToolEnabled: boolean;
  maintenanceMode: boolean;
  publicStatusMessage: string;
  toolVersion: string;
  toolAccessPolicy: ToolAccessPolicy;
  premiumRequirements: string;
  dsApiKey: string;
  dsApiUrl: string;
  dsApiKeyLast4?: string;
  dsLastTestAt?: Date;
  dsLastTestSuccess?: boolean;
  dsLastTestMessage?: string;
  dsLastTestLatencyMs?: number;
  dsLastRequestAt?: Date;
  dsLastSuccessAt?: Date;
  dsLastErrorAt?: Date;
  dsLastError?: string;
  dsLastStatusCode?: number;
  dsLastRequestId?: string;
  updatedByAdminId?: mongoose.Types.ObjectId;
  updatedByAdminEmail?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IToolSettingsModel extends mongoose.Model<IToolSettings> {
  getSettings(): Promise<IToolSettings>;
}

const ToolSettingsSchema = new Schema<IToolSettings>(
  {
    isToolEnabled: {
      type: Boolean,
      default: true
    },
    maintenanceMode: {
      type: Boolean,
      default: false
    },
    publicStatusMessage: {
      type: String,
      default: 'All roulette prediction systems and real-time feeds are operating normally.'
    },
    toolVersion: {
      type: String,
      default: 'v2.5.0-pro'
    },
    toolAccessPolicy: {
      type: String,
      enum: ['PREMIUM_ONLY', 'OPEN_BETA', 'MAINTENANCE'],
      default: 'PREMIUM_ONLY'
    },
    premiumRequirements: {
      type: String,
      default: 'Active paid subscription or authorized administrator credential required for live table access.'
    },
    dsApiKey: {
      type: String,
      default: ''
    },
    dsApiUrl: {
      type: String,
      default: ''
    },
    dsApiKeyLast4: {
      type: String,
      default: ''
    },
    dsLastTestAt: {
      type: Date
    },
    dsLastTestSuccess: {
      type: Boolean
    },
    dsLastTestMessage: {
      type: String,
      default: ''
    },
    dsLastTestLatencyMs: {
      type: Number
    },
    dsLastRequestAt: {
      type: Date
    },
    dsLastSuccessAt: {
      type: Date
    },
    dsLastErrorAt: {
      type: Date
    },
    dsLastError: {
      type: String,
      default: ''
    },
    dsLastStatusCode: {
      type: Number
    },
    dsLastRequestId: {
      type: String,
      default: ''
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

ToolSettingsSchema.statics.getSettings = async function (): Promise<IToolSettings> {
  let doc = await this.findOne();
  if (!doc) {
    doc = await this.create({
      isToolEnabled: true,
      maintenanceMode: false,
      publicStatusMessage: 'All roulette prediction systems and real-time feeds are operating normally.',
      toolVersion: 'v2.5.0-pro',
      toolAccessPolicy: 'PREMIUM_ONLY',
      premiumRequirements: 'Active paid subscription or authorized administrator credential required for live table access.',
      dsApiKey: '',
      dsApiUrl: ''
    });
  }
  return doc;
};

export const ToolSettingsModel =
  (mongoose.models.ToolSettings as IToolSettingsModel) ||
  mongoose.model<IToolSettings, IToolSettingsModel>('ToolSettings', ToolSettingsSchema);
