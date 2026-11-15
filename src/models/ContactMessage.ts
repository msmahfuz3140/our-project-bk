import mongoose, { Schema, Document } from 'mongoose';

export type ContactMessageStatus = 'NEW' | 'READ' | 'RESOLVED' | 'SPAM';

export interface IContactMessage extends Document {
  name: string;
  email: string;
  subject: string;
  message: string;
  status: ContactMessageStatus;
  userId?: mongoose.Types.ObjectId;
  ip?: string;
  userAgent?: string;
  resolvedByAdminId?: mongoose.Types.ObjectId;
  resolvedByAdminEmail?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ContactMessageSchema = new Schema<IContactMessage>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000
    },
    status: {
      type: String,
      enum: ['NEW', 'READ', 'RESOLVED', 'SPAM'],
      default: 'NEW',
      index: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      sparse: true,
      index: true
    },
    ip: {
      type: String
    },
    userAgent: {
      type: String,
      maxlength: 500
    },
    resolvedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    resolvedByAdminEmail: {
      type: String
    },
    resolvedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

ContactMessageSchema.index({ status: 1, createdAt: -1 });
ContactMessageSchema.index({ createdAt: -1 });

export const ContactMessageModel =
  mongoose.models.ContactMessage ||
  mongoose.model<IContactMessage>('ContactMessage', ContactMessageSchema);
