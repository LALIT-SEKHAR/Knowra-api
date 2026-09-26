import {
  documentProviderLabel,
  readModelFor,
  resolveDocumentProvider,
  type DocumentProviderId,
} from '../../config/documentProviders.js';
import {
  resolveChatSelection,
  type ChatProviderId,
} from '../../config/chatProviders.js';
import { AppError } from '../../utils/errors.js';
import { decryptSecret } from '../../utils/crypto.js';

export type SecretOwner = {
  documentProvider?: string | null;
  documentModel?: string | null;
  openaiApiKeyEncrypted?: string | null;
  googleApiKeyEncrypted?: string | null;
  anthropicApiKeyEncrypted?: string | null;
  xaiApiKeyEncrypted?: string | null;
  customApiKeyEncrypted?: string | null;
  customBaseUrl?: string | null;
  chatProvider?: string | null;
  chatModel?: string | null;
};

export type DocumentCredentials = {
  provider: DocumentProviderId;
  apiKey: string;
  baseURL?: string;
  readModel: string;
  embeddingModel: string;
};

export function documentKeyReady(owner: SecretOwner, provider?: DocumentProviderId): boolean {
  const resolved = provider ?? resolveDocumentProvider(owner.documentProvider);
  if (resolved === 'openai') return Boolean(owner.openaiApiKeyEncrypted);
  if (resolved === 'google') return Boolean(owner.googleApiKeyEncrypted);
  return Boolean(owner.customBaseUrl?.trim());
}

export function chatKeyReady(owner: SecretOwner, provider: ChatProviderId): boolean {
  if (provider === 'openai') return Boolean(owner.openaiApiKeyEncrypted);
  if (provider === 'anthropic') return Boolean(owner.anthropicApiKeyEncrypted);
  if (provider === 'google') return Boolean(owner.googleApiKeyEncrypted);
  if (provider === 'xai') return Boolean(owner.xaiApiKeyEncrypted);
  return Boolean(owner.customBaseUrl?.trim());
}

export function workspaceCanChat(owner: SecretOwner): boolean {
  const provider = resolveDocumentProvider(owner.documentProvider);
  if (!documentKeyReady(owner, provider)) return false;
  if (provider === 'custom' && !readModelFor(provider, owner.documentModel)) return false;
  const chat = resolveChatSelection(owner.chatProvider, owner.chatModel);
  return chatKeyReady(owner, chat.provider);
}

export function missingDocumentKeyMessage(provider: DocumentProviderId, forOrg = false): string {
  const label = documentProviderLabel(provider);
  if (provider === 'custom') {
    return forOrg
      ? 'Your organization admin needs to add a custom API base URL in Settings → AI'
      : 'Add a custom API base URL in Settings → AI before uploading';
  }
  return forOrg
    ? `Your organization admin needs to add a ${label} API key in Settings → AI`
    : `Add your ${label} API key in Settings → AI before uploading`;
}

export function documentCredentials(owner: SecretOwner): DocumentCredentials | null {
  const provider = resolveDocumentProvider(owner.documentProvider);
  if (!documentKeyReady(owner, provider)) return null;

  const readModel = readModelFor(provider, owner.documentModel);
  if (provider === 'custom' && !readModel) return null;

  if (provider === 'google') {
    return {
      provider,
      apiKey: decryptSecret(owner.googleApiKeyEncrypted!),
      readModel,
      embeddingModel: 'gemini-embedding-001',
    };
  }

  if (provider === 'custom') {
    return {
      provider,
      apiKey: owner.customApiKeyEncrypted ? decryptSecret(owner.customApiKeyEncrypted) : 'not-needed',
      baseURL: owner.customBaseUrl!.replace(/\/$/, ''),
      readModel,
      embeddingModel: 'text-embedding-3-small',
    };
  }

  return {
    provider: 'openai',
    apiKey: decryptSecret(owner.openaiApiKeyEncrypted!),
    readModel,
    embeddingModel: 'text-embedding-3-small',
  };
}

export function assertCanProcessDocuments(owner: SecretOwner): DocumentProviderId {
  const provider = resolveDocumentProvider(owner.documentProvider);
  if (!documentKeyReady(owner, provider)) {
    throw new AppError(missingDocumentKeyMessage(provider), 400);
  }
  if (provider === 'custom' && !readModelFor(provider, owner.documentModel)) {
    throw new AppError('Type a model name in Settings → AI before using Custom for documents', 400);
  }
  return provider;
}
