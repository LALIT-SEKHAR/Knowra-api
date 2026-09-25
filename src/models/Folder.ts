import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const folderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    name: { type: String, required: true, trim: true },
    /** Lowercase name used to keep sibling folders unique regardless of case. */
    nameKey: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
  },
  { timestamps: true },
);

folderSchema.index({ userId: 1, orgId: 1, parentId: 1, nameKey: 1 }, { unique: true });
folderSchema.index({ userId: 1, parentId: 1, name: 1 });

export type FolderDocument = InferSchemaType<typeof folderSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const FolderModel: Model<FolderDocument> =
  mongoose.models.Folder || mongoose.model<FolderDocument>('Folder', folderSchema);
