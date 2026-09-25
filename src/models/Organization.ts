import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** Lowercase name used for uniqueness across the app. */
    nameKey: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    logoUrl: { type: String },
    logoPublicId: { type: String },
    /** When false, the invite link does not add new members. */
    joinsEnabled: { type: Boolean, default: true },

    openaiApiKeyEncrypted: { type: String },
    openaiKeyLast4: { type: String },
    chatProvider: { type: String, default: 'openai' },
    chatModel: { type: String, default: 'gpt-4o-mini' },
    anthropicApiKeyEncrypted: { type: String },
    anthropicKeyLast4: { type: String },
    googleApiKeyEncrypted: { type: String },
    googleKeyLast4: { type: String },
    xaiApiKeyEncrypted: { type: String },
    xaiKeyLast4: { type: String },
    customApiKeyEncrypted: { type: String },
    customKeyLast4: { type: String },
    customBaseUrl: { type: String },
  },
  { timestamps: true },
);

export type OrganizationAttrs = InferSchemaType<typeof organizationSchema>;
export type OrganizationDocument = HydratedDocument<OrganizationAttrs>;

export const Organization: Model<OrganizationAttrs> =
  mongoose.models.Organization ||
  mongoose.model<OrganizationAttrs>('Organization', organizationSchema);
