import mongoose, { Schema, Document } from 'mongoose';

export interface ISystemMigration extends Document {
  key: string;
  appliedAt: Date;
  details?: Record<string, unknown>;
}

const SystemMigrationSchema = new Schema<ISystemMigration>({
  key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  appliedAt: {
    type: Date,
    default: Date.now
  },
  details: {
    type: Schema.Types.Mixed
  }
}, {
  timestamps: true
});

export const SystemMigrationModel =
  mongoose.models.SystemMigration ||
  mongoose.model<ISystemMigration>('SystemMigration', SystemMigrationSchema);
