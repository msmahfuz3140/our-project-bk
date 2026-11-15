import mongoose, { Schema, Document } from 'mongoose';

export type PaymentEventProcessingStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'IGNORED'
  | 'DUPLICATE'
  | 'REJECTED'
  | 'FAILED';

export interface IPaymentEvent extends Document {
  provider: string;
  providerEventId: string;
  paymentId?: mongoose.Types.ObjectId;
  providerPaymentId?: string;
  orderId?: string;
  eventType: string;
  processingStatus: PaymentEventProcessingStatus;
  signatureValid: boolean;
  errorMessage?: string;
  receivedAt: Date;
  processedAt?: Date;
  rawPayload?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentEventSchema = new Schema<IPaymentEvent>({
  provider: {
    type: String,
    required: true,
    default: 'NOWPAYMENTS',
    index: true
  },
  // Deterministic hash of the canonical provider payload. Unique index is the
  // primary webhook idempotency guard (safe against concurrent duplicates).
  providerEventId: {
    type: String,
    required: true,
    unique: true
  },
  paymentId: {
    type: Schema.Types.ObjectId,
    ref: 'Payment',
    index: true,
    sparse: true
  },
  providerPaymentId: {
    type: String,
    index: true,
    sparse: true
  },
  orderId: {
    type: String,
    index: true,
    sparse: true
  },
  eventType: {
    type: String,
    required: true,
    index: true
  },
  processingStatus: {
    type: String,
    enum: ['RECEIVED', 'PROCESSING', 'PROCESSED', 'IGNORED', 'DUPLICATE', 'REJECTED', 'FAILED'],
    default: 'RECEIVED',
    index: true
  },
  signatureValid: {
    type: Boolean,
    default: false,
    index: true
  },
  errorMessage: {
    type: String
  },
  receivedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  processedAt: {
    type: Date
  },
  rawPayload: {
    type: Schema.Types.Mixed
  }
}, {
  timestamps: true
});

PaymentEventSchema.index({ provider: 1, receivedAt: -1 });
PaymentEventSchema.index({ providerPaymentId: 1, receivedAt: -1 });
PaymentEventSchema.index({ processingStatus: 1, receivedAt: -1 });

export const PaymentEventModel =
  mongoose.models.PaymentEvent || mongoose.model<IPaymentEvent>('PaymentEvent', PaymentEventSchema);
