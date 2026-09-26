import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, OCR_MODEL } from './env.js';

/** Providers that can create embeddings. Claude and Grok are chat-only. */
export const DOCUMENT_PROVIDERS = ['openai', 'google', 'custom'] as const;

export type DocumentProviderId = (typeof DOCUMENT_PROVIDERS)[number];

export const GEMINI_READ_MODEL = 'gemini-3.8-flash';
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';
/** Shorter than OpenAI's 1536 so Gemini vectors stay on their own Atlas index. */
export const GEMINI_EMBEDDING_DIMENSIONS = 768;
export const GEMINI_VECTOR_INDEX_NAME = 'chunk_embedding_index_gemini';

/**
 * Published USD per 1 million embedding tokens.
 * OpenAI text-embedding-3-small: $0.02. Gemini gemini-embedding-001: $0.15.
 * Custom endpoints are omitted because the price is not Knowra's to know.
 */
export const EMBEDDING_USD_PER_MILLION: Partial<Record<DocumentProviderId, number>> = {
  openai: 0.02,
  google: 0.15,
};

export function isDocumentProviderId(value: string): value is DocumentProviderId {
  return (DOCUMENT_PROVIDERS as readonly string[]).includes(value);
}

export function resolveDocumentProvider(value?: string | null): DocumentProviderId {
  if (value && isDocumentProviderId(value)) return value;
  return 'openai';
}

export function documentProviderLabel(provider: DocumentProviderId): string {
  if (provider === 'google') return 'Gemini';
  if (provider === 'custom') return 'Custom';
  return 'OpenAI';
}

export function embeddingModelFor(provider: DocumentProviderId): string {
  if (provider === 'google') return GEMINI_EMBEDDING_MODEL;
  return EMBEDDING_MODEL;
}

export function embeddingDimensionsFor(provider: DocumentProviderId): number {
  if (provider === 'google') return GEMINI_EMBEDDING_DIMENSIONS;
  return EMBEDDING_DIMENSIONS;
}

export function vectorIndexFor(provider: DocumentProviderId, openAIIndexName: string): string {
  if (provider === 'google') return GEMINI_VECTOR_INDEX_NAME;
  return openAIIndexName;
}

export function readModelFor(
  provider: DocumentProviderId,
  documentModel?: string | null,
): string {
  if (provider === 'google') return GEMINI_READ_MODEL;
  if (provider === 'custom') return (documentModel ?? '').trim();
  return OCR_MODEL;
}

/** Missing or openai covers chunks created before embeddingProvider was stored. */
export function storedEmbeddingMatches(
  stored: string | null | undefined,
  provider: DocumentProviderId,
): boolean {
  return (stored || 'openai') === provider;
}

export function embeddingProviderMongoFilter(
  provider: DocumentProviderId,
): Record<string, unknown> {
  if (provider === 'openai') {
    return {
      $or: [
        { embeddingProvider: 'openai' },
        { embeddingProvider: { $exists: false } },
        { embeddingProvider: null },
      ],
    };
  }
  return { embeddingProvider: provider };
}
