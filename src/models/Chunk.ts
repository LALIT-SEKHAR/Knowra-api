import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';
import { EMBEDDING_DIMENSIONS } from '../config/env.js';

const chunkSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    pageNumber: { type: Number },
    chunkIndex: { type: Number, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

chunkSchema.index({ documentId: 1, chunkIndex: 1 });
chunkSchema.index({ userId: 1, documentId: 1 });

export type ChunkDocument = InferSchemaType<typeof chunkSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Chunk: Model<ChunkDocument> =
  mongoose.models.Chunk || mongoose.model<ChunkDocument>('Chunk', chunkSchema);

export { EMBEDDING_DIMENSIONS };
