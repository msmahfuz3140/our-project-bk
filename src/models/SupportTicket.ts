import mongoose, { Schema, Document } from 'mongoose';

export type TicketCategory = 'BILLING' | 'TOOL_ACCESS' | 'ACCOUNT' | 'OTHER';
export type TicketPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

export interface ITicketMessage {
  _id?: mongoose.Types.ObjectId;
  senderId: mongoose.Types.ObjectId;
  senderEmail: string;
  senderRole: string;
  message: string;
  isInternalNote: boolean;
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  ticketNumber: string;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  assignedToAdminId?: mongoose.Types.ObjectId;
  assignedToAdminEmail?: string;
  relatedPaymentId?: mongoose.Types.ObjectId;
  relatedSubscriptionId?: mongoose.Types.ObjectId;
  messages: ITicketMessage[];
  lastRepliedAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TicketMessageSchema = new Schema<ITicketMessage>(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    senderEmail: {
      type: String,
      required: true
    },
    senderRole: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true,
      trim: true
    },
    isInternalNote: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { _id: true }
);

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    userName: {
      type: String,
      required: true
    },
    userEmail: {
      type: String,
      required: true,
      index: true
    },
    subject: {
      type: String,
      required: true,
      trim: true
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    category: {
      type: String,
      enum: ['BILLING', 'TOOL_ACCESS', 'ACCOUNT', 'OTHER'],
      default: 'OTHER',
      index: true
    },
    priority: {
      type: String,
      enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
      default: 'MEDIUM',
      index: true
    },
    status: {
      type: String,
      enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
      default: 'OPEN',
      index: true
    },
    assignedToAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User'
    },
    assignedToAdminEmail: {
      type: String
    },
    relatedPaymentId: {
      type: Schema.Types.ObjectId,
      ref: 'Payment'
    },
    relatedSubscriptionId: {
      type: Schema.Types.ObjectId,
      ref: 'Subscription'
    },
    messages: [TicketMessageSchema],
    lastRepliedAt: {
      type: Date
    },
    resolvedAt: {
      type: Date
    },
    closedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

SupportTicketSchema.index({ createdAt: -1 });
SupportTicketSchema.index({ status: 1, priority: 1 });

export const SupportTicketModel = mongoose.model<ISupportTicket>('SupportTicket', SupportTicketSchema);
