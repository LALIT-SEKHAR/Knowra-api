import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

otpSchema.index({ email: 1, consumed: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OtpDocument = InferSchemaType<typeof otpSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Otp: Model<OtpDocument> =
  mongoose.models.Otp || mongoose.model<OtpDocument>('Otp', otpSchema);
