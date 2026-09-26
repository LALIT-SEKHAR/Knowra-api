import { defaultModelForProvider, getChatProvider } from '../../config/chatProviders.js';
import {
  documentProviderLabel,
  EMBEDDING_USD_PER_MILLION,
  embeddingModelFor,
  readModelFor,
  resolveDocumentProvider,
  type DocumentProviderId,
} from '../../config/documentProviders.js';
import { Chunk } from '../../models/Chunk.js';
import { DocumentModel } from '../../models/Document.js';
import type { UserDocument } from '../../models/User.js';
import { AppError } from '../../utils/errors.js';
import { enqueueJob } from '../jobs/worker.js';
import { isImageMime } from './fileTypes.js';
import { documentKeyReady, missingDocumentKeyMessage, type SecretOwner } from './access.js';

export type RebuildPreview = {
  fileCount: number;
  imageFileCount: number;
  imagePageCount: number;
  estimatedTokens: number;
  estimatedUsd: number | null;
  priceKnown: boolean;
  providerLabel: string;
  embeddingModel: string;
  chatModel: string;
  chatModelLabel: string;
};

export async function previewDocumentRebuild(
  library: object,
  provider: DocumentProviderId,
  documentModel?: string,
): Promise<RebuildPreview> {
  const [charRow] = await Chunk.aggregate<{ chars?: number }>([
    { $match: library },
    { $group: { _id: null, chars: { $sum: { $strLenCP: '$content' } } } },
  ]);
  const chars = charRow?.chars ?? 0;
  const estimatedTokens = chars === 0 ? 0 : Math.max(1, Math.ceil(chars / 4));
  const docs = await DocumentModel.find({ ...library, status: 'ready' }).select('mimeType pageCount');
  const images = docs.filter((doc) => isImageMime(doc.mimeType));
  const price = EMBEDDING_USD_PER_MILLION[provider];
  const priceKnown = typeof price === 'number';
  const chatModel =
    provider === 'custom'
      ? (documentModel ?? '').trim()
      : defaultModelForProvider(provider);
  const catalog = provider === 'custom' ? undefined : getChatProvider(provider);
  const chatModelLabel =
    catalog?.models.find((model) => model.id === chatModel)?.label || chatModel || 'your model';

  return {
    fileCount: docs.length,
    imageFileCount: images.length,
    imagePageCount: images.reduce((sum, doc) => sum + (doc.pageCount || 1), 0),
    estimatedTokens,
    estimatedUsd: priceKnown ? (estimatedTokens / 1_000_000) * price : null,
    priceKnown,
    providerLabel: documentProviderLabel(provider),
    embeddingModel: embeddingModelFor(provider),
    chatModel,
    chatModelLabel,
  };
}

export async function applyDocumentProvider(params: {
  owner: UserDocument;
  library: object;
  provider: DocumentProviderId;
  documentModel?: string;
  confirm: boolean;
}): Promise<{ rebuilt: boolean; fileCount: number }> {
  const ownerSecrets = params.owner as UserDocument & SecretOwner;
  const current = resolveDocumentProvider(ownerSecrets.documentProvider);
  const model =
    params.provider === 'custom'
      ? (params.documentModel || ownerSecrets.documentModel || '').trim()
      : readModelFor(params.provider);

  if (params.provider === 'custom' && !model) {
    throw new AppError('Type a model name before using Custom for documents', 400);
  }
  if (!documentKeyReady(ownerSecrets, params.provider)) {
    throw new AppError(missingDocumentKeyMessage(params.provider), 400);
  }

  if (current === params.provider) {
    if (params.provider === 'custom' && model && model !== ownerSecrets.documentModel) {
      params.owner.documentModel = model;
      await params.owner.save();
    }
    return { rebuilt: false, fileCount: 0 };
  }

  const preview = await previewDocumentRebuild(params.library, params.provider, model);
  if (preview.fileCount > 0 && !params.confirm) {
    throw new AppError('Confirm re-embedding before changing the document provider', 409);
  }

  params.owner.documentProvider = params.provider;
  params.owner.documentModel = model;
  params.owner.chatProvider = params.provider;
  params.owner.chatModel = params.provider === 'custom' ? model : defaultModelForProvider(params.provider);
  await params.owner.save();
  await Chunk.deleteMany(params.library);

  if (preview.fileCount === 0) {
    return { rebuilt: false, fileCount: 0 };
  }

  const ready = await DocumentModel.find({ ...params.library, status: 'ready' }).select('_id userId');
  await DocumentModel.updateMany(
    { ...params.library, status: 'ready' },
    {
      $set: {
        status: 'processing',
        stage: 'queued',
        progress: 0,
      },
      $unset: { processingStartedAt: 1, errorMessage: 1 },
    },
  );
  for (const doc of ready) {
    await enqueueJob('process_document', {
      documentId: doc._id.toString(),
      userId: doc.userId.toString(),
    });
  }

  return { rebuilt: true, fileCount: ready.length };
}
