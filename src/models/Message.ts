import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const sourceSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, required: true },
    documentName: { type: String },
    chunkId: { type: Schema.Types.ObjectId, required: true },
    pageNumber: { type: Number },
  },
  { _id: false },
);

const mentionSchema = new Schema(
  {
    name: { type: String, required: true },
    at: { type: Number, required: true },
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
    /** Tool steps the tutor actually took, shown on the reply. */
    steps: { type: [String], default: undefined },
    quizId: { type: Schema.Types.ObjectId, ref: 'Quiz' },
    /** File name inserted in the user text, with the character index where it starts. */
    mention: { type: mentionSchema, default: undefined },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export type MessageDocument = InferSchemaType<typeof messageSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Message: Model<MessageDocument> =
  mongoose.models.Message || mongoose.model<MessageDocument>('Message', messageSchema);
