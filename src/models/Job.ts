import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

export const JOB_TYPES = ['process_document', 'delete_document', 'purge_account'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const jobSchema = new Schema(
  {
    type: { type: String, enum: JOB_TYPES, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'pending', index: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextRunAt: { type: Date, default: () => new Date(), index: true },
    lastError: { type: String },
    lockedAt: { type: Date },
    lockedBy: { type: String },
  },
  { timestamps: true },
);

jobSchema.index({ status: 1, nextRunAt: 1 });

export type JobDocument = InferSchemaType<typeof jobSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Job: Model<JobDocument> =
  mongoose.models.Job || mongoose.model<JobDocument>('Job', jobSchema);
