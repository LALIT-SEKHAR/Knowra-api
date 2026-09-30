import mongoose, { Schema, type HydratedDocument, type InferSchemaType, type Model } from 'mongoose';

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    avatarUrl: { type: String },
    avatarPublicId: { type: String },

    /** Required when documentProvider or chat is OpenAI. */
    openaiApiKeyEncrypted: { type: String },
    openaiKeyLast4: { type: String },

    /** Who reads files and builds embeddings. Claude and Grok are not valid here. */
    documentProvider: { type: String, default: 'openai' },
    /** Vision model for Custom documents. OpenAI and Gemini use fixed defaults. */
    documentModel: { type: String },

    /** Chat answer provider. Can differ from documentProvider. */
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
    /** OpenAI-compatible base URL for custom chat, e.g. https://api.groq.com/openai/v1 */
    customBaseUrl: { type: String },

    /** Null means the personal workspace. Set when the user is inside an organization. */
    activeOrgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },

    lastLoginAt: { type: Date },
    deletionRequestedAt: { type: Date },
    deletionScheduledFor: { type: Date, index: true },
    /** Bumped on sign-out so previously issued tokens stop working. */
    authVersion: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserAttrs>;

export const User: Model<UserAttrs> =
  mongoose.models.User || mongoose.model<UserAttrs>('User', userSchema);
