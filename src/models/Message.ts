import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const sourceSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, required: true },
    chunkId: { type: Schema.Types.ObjectId, required: true },
    pageNumber: { type: Number },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    sources: { type: [sourceSchema], default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type MessageDocument = InferSchemaType<typeof messageSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Message: Model<MessageDocument> =
  mongoose.models.Message || mongoose.model<MessageDocument>('Message', messageSchema);
