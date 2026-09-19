import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', index: true },
    title: { type: String, trim: true },
  },
  { timestamps: true },
);

conversationSchema.index({ userId: 1, updatedAt: -1 });

export type ConversationDocument = InferSchemaType<typeof conversationSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Conversation: Model<ConversationDocument> =
  mongoose.models.Conversation ||
  mongoose.model<ConversationDocument>('Conversation', conversationSchema);
