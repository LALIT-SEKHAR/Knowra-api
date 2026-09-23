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
    /** Ordered raw objects. Set when the PDF is larger than one Cloudinary object. */
    cloudinaryParts: {
      type: [
        {
          publicId: { type: String, required: true },
          url: { type: String, required: true },
        },
      ],
      default: undefined,
    },
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
    /** Current processing step, used for status copy and time estimates */
    stage: {
      type: String,
      enum: ['queued', 'downloading', 'reading', 'extracting', 'indexing', 'finishing'],
    },
    processingStartedAt: { type: Date },
    /** Null when the file sits at the library root. */
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  },
  { timestamps: true },
);

documentSchema.index({ userId: 1, createdAt: -1 });
documentSchema.index({ userId: 1, folderId: 1, updatedAt: -1 });

export type DocumentDocument = InferSchemaType<typeof documentSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const DocumentModel: Model<DocumentDocument> =
  mongoose.models.Document ||
  mongoose.model<DocumentDocument>('Document', documentSchema);
