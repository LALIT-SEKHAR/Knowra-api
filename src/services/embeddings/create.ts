import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../../config/env.js';
import {
  embeddingDimensionsFor,
  type DocumentProviderId,
} from '../../config/documentProviders.js';
import { AppError } from '../../utils/errors.js';
import { geminiEmbedDocuments, geminiEmbedQuery } from '../google/gemini.js';
import {
  createEmbedding,
  createEmbeddings,
  type EmbeddingResult,
  type EmbeddingsResult,
} from '../openai/client.js';

export type EmbedTarget = {
  provider: DocumentProviderId;
  apiKey: string;
  baseURL?: string;
};

function assertDimensions(vectors: number[][], provider: DocumentProviderId): void {
  const expected = embeddingDimensionsFor(provider);
  const wrong = vectors.find((vector) => vector.length !== expected);
  if (!wrong) return;
  if (provider === 'custom') {
    throw new AppError(
      `This endpoint returned embeddings of length ${wrong.length}. Knowra needs ${EMBEDDING_DIMENSIONS}-length vectors from ${EMBEDDING_MODEL}.`,
      502,
    );
  }
  throw new AppError(
    `Embeddings were length ${wrong.length}. ${provider === 'google' ? 'Gemini' : 'OpenAI'} search expects ${expected}.`,
    502,
  );
}

export async function embedDocumentChunks(
  target: EmbedTarget,
  texts: string[],
  onProgress?: (completed: number, total: number) => void | Promise<void>,
): Promise<EmbeddingsResult> {
  try {
    const result =
      target.provider === 'google'
        ? await geminiEmbedDocuments(target.apiKey, texts, onProgress)
        : await createEmbeddings(target.apiKey, texts, onProgress, {
            baseURL: target.baseURL,
            model: EMBEDDING_MODEL,
          });
    assertDimensions(result.embeddings, target.provider);
    return result;
  } catch (error) {
    if (target.provider === 'custom' && !(error instanceof AppError)) {
      const detail = error instanceof Error ? error.message : 'Embeddings request failed';
      throw new AppError(
        `Could not create embeddings (${detail}). The custom endpoint must support OpenAI-style /embeddings and return ${EMBEDDING_DIMENSIONS}-length vectors.`,
        502,
      );
    }
    throw error;
  }
}

export async function embedSearchQuery(target: EmbedTarget, text: string): Promise<EmbeddingResult> {
  if (target.provider === 'google') {
    return geminiEmbedQuery(target.apiKey, text);
  }
  const result = await createEmbedding(target.apiKey, text, {
    baseURL: target.baseURL,
    model: EMBEDDING_MODEL,
  });
  assertDimensions([result.embedding], target.provider);
  return result;
}
