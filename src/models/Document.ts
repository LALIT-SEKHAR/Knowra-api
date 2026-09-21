import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

export const DOCUMENT_STATUSES = ['uploading', 'processing', 'ready', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const documentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    cloudinaryPublicId: { type: String, required: true },
    cloudinaryUrl: { type: String, required: true },
    status: {
      type: String,
      enum: DOCUMENT_STATUSES,
      default: 'uploading',
      index: true,
    },
    errorMessage: { type: String },
    pageCount: { type: Number },
    /** 0–100 while processing; 100 when ready */
    progress: { type: Number, min: 0, max: 100, default: 0 },
  },
  { timestamps: true },
);

documentSchema.index({ userId: 1, createdAt: -1 });

export type DocumentDocument = InferSchemaType<typeof documentSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const DocumentModel: Model<DocumentDocument> =
  mongoose.models.Document ||
  mongoose.model<DocumentDocument>('Document', documentSchema);
