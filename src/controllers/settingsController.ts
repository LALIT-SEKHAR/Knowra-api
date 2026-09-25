import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { encryptSecret, lastFour } from '../utils/crypto.js';
import { ACCOUNT_DELETION_GRACE_DAYS } from '../config/env.js';
import {
  CHAT_PROVIDERS,
  CHAT_PROVIDER_IDS,
  DEFAULT_CHAT_PROVIDER,
  defaultModelForProvider,
  resolveChatSelection,
  type ChatProviderId,
} from '../config/chatProviders.js';
import type { UserDocument } from '../models/User.js';
import { User } from '../models/User.js';
import { validateOpenAIKey } from '../services/openai/client.js';
import { validateChatProviderKey } from '../services/chat/generate.js';
import {
  requestDeleteAccountOtp,
  requestDeleteFilesOtp,
  verifyDeleteAccountOtp,
  verifyDeleteFilesOtp,
} from '../services/auth/otp.js';
import {
  cancelAccountDeletion,
  clearUserChatHistory,
  deleteAllUserDocuments,
  scheduleAccountDeletion,
} from '../services/user/purge.js';
import { enqueueJob } from '../services/jobs/worker.js';
import { serializeUser } from './authController.js';
import { orgsNeedingSuccessor } from '../services/orgs/workspace.js';

const keySchema = z.object({
  apiKey: z.string().min(10),
});

const chatPrefsSchema = z.object({
  chatProvider: z.enum(CHAT_PROVIDER_IDS),
  chatModel: z.string().trim().min(1).max(120),
  customBaseUrl: z.string().trim().url().optional(),
});

const providerKeySchema = z.object({
  provider: z.enum(['anthropic', 'google', 'xai', 'custom'] as const),
  apiKey: z.string().optional().default(''),
  baseUrl: z.string().trim().url().optional(),
  /** When saving a key, also activate this provider for chat. */
  activate: z.boolean().optional().default(true),
  chatModel: z.string().trim().min(1).max(120).optional(),
});

const otpCodeSchema = z.object({
  code: z.string().min(4).max(10),
});

const deleteFilesSchema = z.object({
  code: z.string().min(4).max(10),
  deleteFolders: z.boolean().optional().default(false),
});

function hasChatProviderKey(user: UserDocument, provider: ChatProviderId): boolean {
  if (provider === 'openai') return Boolean(user.openaiApiKeyEncrypted);
  if (provider === 'anthropic') return Boolean(user.anthropicApiKeyEncrypted);
  if (provider === 'google') return Boolean(user.googleApiKeyEncrypted);
  if (provider === 'xai') return Boolean(user.xaiApiKeyEncrypted);
  // Custom endpoints often have no API key (local Ollama, etc.) — base URL is enough.
  return Boolean(user.customBaseUrl?.trim());
}

export function settingsPayload(user: UserDocument) {
  const { provider, model } = resolveChatSelection(user.chatProvider, user.chatModel);
  return {
    hasOpenAIKey: Boolean(user.openaiApiKeyEncrypted),
    openaiKeyLast4: user.openaiKeyLast4 ?? null,
    chatProvider: provider,
    chatModel: model,
    chatProviders: CHAT_PROVIDERS,
    hasAnthropicKey: Boolean(user.anthropicApiKeyEncrypted),
    anthropicKeyLast4: user.anthropicKeyLast4 ?? null,
    hasGoogleKey: Boolean(user.googleApiKeyEncrypted),
    googleKeyLast4: user.googleKeyLast4 ?? null,
    hasXaiKey: Boolean(user.xaiApiKeyEncrypted),
    xaiKeyLast4: user.xaiKeyLast4 ?? null,
    hasCustomKey: Boolean(user.customApiKeyEncrypted),
    customKeyLast4: user.customKeyLast4 ?? null,
    customBaseUrl: user.customBaseUrl ?? null,
    canChat: Boolean(user.openaiApiKeyEncrypted) && hasChatProviderKey(user, provider),
    deletionScheduledFor: user.deletionScheduledFor
      ? new Date(user.deletionScheduledFor).toISOString()
      : null,
  };
}

function editableKeys(req: AuthedRequest): UserDocument {
  if (!req.workspace?.canManage) {
    throw new AppError('Only an organization admin can change AI setup', 403);
  }
  return (req.workspace.org ?? req.user!) as UserDocument;
}

export const getSettingsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const source = req.workspace?.org ?? req.user!;
  const payload = settingsPayload(source as UserDocument);
  if (req.workspace?.canManage) {
    res.json(payload);
    return;
  }
  res.json({
    ...payload,
    openaiKeyLast4: null,
    anthropicKeyLast4: null,
    googleKeyLast4: null,
    xaiKeyLast4: null,
    customKeyLast4: null,
    customBaseUrl: null,
  });
});

export const putOpenAIKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = keySchema.parse(req.body);
  const apiKey = body.apiKey.trim();
  try {
    await validateOpenAIKey(apiKey);
  } catch {
    throw new AppError('Invalid OpenAI API key', 400);
  }

  const user = editableKeys(req);
  user.openaiApiKeyEncrypted = encryptSecret(apiKey);
  user.openaiKeyLast4 = lastFour(apiKey);
  await user.save();

  res.json(settingsPayload(user));
});

export const deleteOpenAIKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = editableKeys(req);
  user.openaiApiKeyEncrypted = undefined;
  user.openaiKeyLast4 = undefined;
  await user.save();
  res.json(settingsPayload(user));
});

export const putChatPrefsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = chatPrefsSchema.parse(req.body);
  const user = editableKeys(req);
  const { provider, model } = resolveChatSelection(body.chatProvider, body.chatModel);

  if (provider === 'custom' && body.customBaseUrl) {
    user.customBaseUrl = body.customBaseUrl.replace(/\/$/, '');
  }

  // Only activate a provider once required setup is present — avoids breaking home chat.
  if (!hasChatProviderKey(user, provider)) {
    const label =
      provider === 'anthropic'
        ? 'Claude'
        : provider === 'google'
          ? 'Gemini'
          : provider === 'xai'
            ? 'Grok'
            : provider === 'custom'
              ? 'Custom'
              : 'OpenAI';
    throw new AppError(
      provider === 'custom'
        ? 'Add a custom base URL before using Custom chat'
        : provider === 'openai'
          ? 'Add your OpenAI API key before chatting'
          : `Add your ${label} API key before switching chat to ${label}`,
      400,
    );
  }

  user.chatProvider = provider;
  user.chatModel = provider === 'custom' ? body.chatModel.trim() : model;

  await user.save();
  res.json(settingsPayload(user));
});

/** @deprecated prefer putChatPrefsHandler — kept for older clients */
export const putChatModelHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = z
    .object({
      chatModel: z.string().trim().min(1).max(120),
      chatProvider: z.enum(CHAT_PROVIDER_IDS).optional(),
    })
    .parse(req.body);

  const user = editableKeys(req);
  const provider = (body.chatProvider ?? user.chatProvider ?? DEFAULT_CHAT_PROVIDER) as ChatProviderId;
  const resolved = resolveChatSelection(provider, body.chatModel);
  if (!hasChatProviderKey(user, resolved.provider)) {
    throw new AppError('Finish provider setup before changing chat model', 400);
  }
  user.chatProvider = resolved.provider;
  user.chatModel = resolved.provider === 'custom' ? body.chatModel : resolved.model;
  await user.save();
  res.json(settingsPayload(user));
});

export const putProviderKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = providerKeySchema.parse(req.body);
  const user = editableKeys(req);
  const apiKey = body.apiKey.trim();

  if (body.provider === 'custom') {
    const baseUrl = body.baseUrl?.trim() || user.customBaseUrl?.trim();
    if (!baseUrl) {
      throw new AppError('Custom base URL is required', 400);
    }
    user.customBaseUrl = baseUrl.replace(/\/$/, '');
    if (apiKey) {
      await validateChatProviderKey('custom', apiKey, user.customBaseUrl);
      user.customApiKeyEncrypted = encryptSecret(apiKey);
      user.customKeyLast4 = lastFour(apiKey);
    }
  } else {
    if (apiKey.length < 10) {
      throw new AppError('API key is required', 400);
    }
    await validateChatProviderKey(body.provider, apiKey);
    if (body.provider === 'anthropic') {
      user.anthropicApiKeyEncrypted = encryptSecret(apiKey);
      user.anthropicKeyLast4 = lastFour(apiKey);
    } else if (body.provider === 'google') {
      user.googleApiKeyEncrypted = encryptSecret(apiKey);
      user.googleKeyLast4 = lastFour(apiKey);
    } else if (body.provider === 'xai') {
      user.xaiApiKeyEncrypted = encryptSecret(apiKey);
      user.xaiKeyLast4 = lastFour(apiKey);
    }
  }

  if (body.activate !== false) {
    const resolved = resolveChatSelection(
      body.provider,
      body.chatModel ?? user.chatModel,
    );
    user.chatProvider = resolved.provider;
    user.chatModel =
      resolved.provider === 'custom'
        ? (body.chatModel ?? user.chatModel ?? resolved.model).trim()
        : resolved.model;
  }

  await user.save();
  res.json(settingsPayload(user));
});

export const deleteProviderKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const provider = z.enum(['anthropic', 'google', 'xai', 'custom']).parse(req.params.provider);
  const user = editableKeys(req);

  if (provider === 'anthropic') {
    user.anthropicApiKeyEncrypted = undefined;
    user.anthropicKeyLast4 = undefined;
  } else if (provider === 'google') {
    user.googleApiKeyEncrypted = undefined;
    user.googleKeyLast4 = undefined;
  } else if (provider === 'xai') {
    user.xaiApiKeyEncrypted = undefined;
    user.xaiKeyLast4 = undefined;
  } else {
    user.customApiKeyEncrypted = undefined;
    user.customKeyLast4 = undefined;
    user.customBaseUrl = undefined;
  }

  if (user.chatProvider === provider) {
    user.chatProvider = DEFAULT_CHAT_PROVIDER;
    user.chatModel = defaultModelForProvider(DEFAULT_CHAT_PROVIDER);
  }

  await user.save();
  res.json(settingsPayload(user));
});

export const clearChatsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const result = await clearUserChatHistory(
    req.user!._id.toString(),
    req.workspace?.orgId?.toString() ?? null,
  );
  res.json({ ok: true, ...result });
});

export const requestDeleteFilesOtpHandler = asyncHandler(
  async (req: AuthedRequest, res: Response) => {
    if (!req.workspace?.canManage) {
      throw new AppError('Only an organization admin can delete files', 403);
    }
    const email = req.user!.email;
    if (!email) throw new AppError('Account email is missing', 400);
    const result = await requestDeleteFilesOtp(email);
    res.json({
      ok: true,
      message: 'If this account is valid, a verification code has been sent.',
      email,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    });
  },
);

export const deleteAllFilesHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = deleteFilesSchema.parse(req.body);
  if (!req.workspace?.canManage) {
    throw new AppError('Only an organization admin can delete files', 403);
  }
  const user = req.user!;
  if (!user.email) throw new AppError('Account email is missing', 400);

  await verifyDeleteFilesOtp(user.email, body.code);
  const result = await deleteAllUserDocuments(user._id.toString(), {
    deleteFolders: body.deleteFolders,
    orgId: req.workspace.orgId?.toString() ?? null,
  });
  res.json({ ok: true, ...result });
});

async function assertAdminSuccessor(userId: string) {
  const orgs = await orgsNeedingSuccessor(userId);
  if (orgs.length === 0) return;
  const names = orgs.map((org) => org.name).join(', ');
  throw new AppError(
    `Make someone else an admin of ${names} before you delete your account.`,
    409,
    { orgs },
  );
}

export const requestDeleteAccountOtpHandler = asyncHandler(
  async (req: AuthedRequest, res: Response) => {
    const email = req.user!.email;
    if (!email) throw new AppError('Account email is missing', 400);
    await assertAdminSuccessor(req.user!._id.toString());
    const result = await requestDeleteAccountOtp(email);
    res.json({
      ok: true,
      message: 'If this account is valid, a verification code has been sent.',
      email,
      graceDays: ACCOUNT_DELETION_GRACE_DAYS,
      expiresAt: result.expiresAt.toISOString(),
      resendAvailableAt: result.resendAvailableAt.toISOString(),
    });
  },
);

export const deleteAccountHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = otpCodeSchema.parse(req.body);
  const user = req.user!;
  if (!user.email) throw new AppError('Account email is missing', 400);

  await verifyDeleteAccountOtp(user.email, body.code);
  await assertAdminSuccessor(user._id.toString());
  const scheduled = await scheduleAccountDeletion(user._id.toString());

  if (!scheduled.alreadyScheduled) {
    await enqueueJob(
      'purge_account',
      { userId: user._id.toString() },
      { nextRunAt: scheduled.deletionScheduledFor },
    );
  }

  const fresh = await User.findById(user._id);
  res.json({
    ok: true,
    graceDays: ACCOUNT_DELETION_GRACE_DAYS,
    deletionScheduledFor: scheduled.deletionScheduledFor.toISOString(),
    alreadyScheduled: scheduled.alreadyScheduled,
    user: serializeUser(fresh ?? user),
  });
});

export const cancelDeleteAccountHandler = asyncHandler(
  async (req: AuthedRequest, res: Response) => {
    const cancelled = await cancelAccountDeletion(req.user!._id.toString());
    const fresh = await User.findById(req.user!._id);
    res.json({
      ok: true,
      cancelled,
      user: serializeUser(fresh ?? req.user!),
    });
  },
);
