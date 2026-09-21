import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

export const OTP_PURPOSES = ['login', 'delete_account', 'delete_files'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

const otpSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    purpose: {
      type: String,
      enum: OTP_PURPOSES,
      default: 'login',
      index: true,
    },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true },
);

otpSchema.index({ email: 1, purpose: 1, consumed: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OtpDocument = InferSchemaType<typeof otpSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Otp: Model<OtpDocument> =
  mongoose.models.Otp || mongoose.model<OtpDocument>('Otp', otpSchema);
