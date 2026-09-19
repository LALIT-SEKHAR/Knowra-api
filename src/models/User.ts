import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    avatarUrl: { type: String },
    avatarPublicId: { type: String },
    openaiApiKeyEncrypted: { type: String },
    openaiKeyLast4: { type: String },
    lastLoginAt: { type: Date },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserAttrs>;

export const User: Model<UserAttrs> =
  mongoose.models.User || mongoose.model<UserAttrs>('User', userSchema);
