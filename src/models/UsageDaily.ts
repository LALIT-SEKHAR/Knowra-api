import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const usageDailySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    /** UTC calendar day as YYYY-MM-DD */
    date: { type: String, required: true },

    uploads: { type: Number, default: 0 },
    ocrPages: { type: Number, default: 0 },
    ocrTokens: { type: Number, default: 0 },
    /** Embedding vectors created (chunks + query embeddings) */
    embeddings: { type: Number, default: 0 },
    embeddingTokens: { type: Number, default: 0 },
    /** Text chunks produced during document tokenization */
    chunks: { type: Number, default: 0 },
    /** Chat turns that received an assistant reply */
    chats: { type: Number, default: 0 },
    chatTokens: { type: Number, default: 0 },
    /** Provider API calls billed against the user's keys */
    aiCalls: { type: Number, default: 0 },
  },
  { timestamps: true },
);

usageDailySchema.index({ userId: 1, date: 1 }, { unique: true });
usageDailySchema.index({ userId: 1, date: -1 });

export type UsageDailyAttrs = InferSchemaType<typeof usageDailySchema>;
export type UsageDailyDocument = UsageDailyAttrs & { _id: mongoose.Types.ObjectId };

export const UsageDaily: Model<UsageDailyDocument> =
  mongoose.models.UsageDaily ||
  mongoose.model<UsageDailyDocument>('UsageDaily', usageDailySchema);
