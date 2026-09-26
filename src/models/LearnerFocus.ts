import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const learnerFocusSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    topic: { type: String, required: true, trim: true },
    topicKey: { type: String, required: true },
    misses: { type: Number, default: 0 },
    correct: { type: Number, default: 0 },
  },
  { timestamps: true },
);

learnerFocusSchema.index({ userId: 1, orgId: 1, topicKey: 1 }, { unique: true });

export type LearnerFocusDocument = InferSchemaType<typeof learnerFocusSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const LearnerFocus: Model<LearnerFocusDocument> =
  mongoose.models.LearnerFocus ||
  mongoose.model<LearnerFocusDocument>('LearnerFocus', learnerFocusSchema);
