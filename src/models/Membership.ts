import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const membershipSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    role: { type: String, enum: ['admin', 'member'], required: true },
    blocked: { type: Boolean, default: false },
  },
  { timestamps: true },
);

membershipSchema.index({ userId: 1, orgId: 1 }, { unique: true });

export type MembershipAttrs = InferSchemaType<typeof membershipSchema>;
export type MembershipDocument = HydratedDocument<MembershipAttrs>;

export const Membership: Model<MembershipAttrs> =
  mongoose.models.Membership || mongoose.model<MembershipAttrs>('Membership', membershipSchema);
