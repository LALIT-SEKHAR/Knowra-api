import {
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL,
} from '../../config/documentProviders.js';
import { AppError } from '../../utils/errors.js';
import {
  estimateTokens,
  withRateLimitRetry,
  type EmbeddingResult,
  type EmbeddingsResult,
  type OcrResult,
  type TokenUsage,
} from '../openai/client.js';

const GEMINI_ROOT = 'https://generativelanguage.googleapis.com/v1beta';

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function usageFromMetadata(metadata?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
} | null): TokenUsage {
  if (!metadata) return emptyUsage();
  const promptTokens = metadata.promptTokenCount ?? 0;
  const completionTokens = metadata.candidatesTokenCount ?? 0;
  const totalTokens = metadata.totalTokenCount ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

async function geminiFetch(apiKey: string, path: string, body: unknown): Promise<Response> {
  return withRateLimitRetry(async () => {
    const response = await fetch(`${GEMINI_ROOT}/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429) {
      const detail = await response.text();
      const error = new Error(detail || 'Gemini rate limit') as Error & { status?: number };
      error.status = 429;
      throw error;
    }
    return response;
  });
}

function dataUrlParts(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new AppError('Could not read the page image for Gemini', 500);
  }
  return { mimeType: match[1], data: match[2] };
}

export async function geminiExtractText(
  apiKey: string,
  model: string,
  dataUrl: string,
  prompt: string,
): Promise<OcrResult> {
  const image = dataUrlParts(dataUrl);
  const response = await geminiFetch(apiKey, `models/${model}:generateContent`, {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: image.mimeType, data: image.data } },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  });
  const data = (await response.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  if (!response.ok) {
    throw new AppError(data.error?.message || 'Gemini could not read this page', 502);
  }
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  const usage = usageFromMetadata(data.usageMetadata);
  if (usage.totalTokens === 0) {
    usage.promptTokens = estimateTokens(prompt) + 1000;
    usage.completionTokens = estimateTokens(text);
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
  return { text, usage };
}

type GeminiEmbedding = { values?: number[] };

async function embedBatch(
  apiKey: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
): Promise<{ vectors: number[][]; usage: TokenUsage }> {
  const response = await geminiFetch(apiKey, `models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`, {
    requests: texts.map((text) => ({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
    })),
  });
  const data = (await response.json().catch(() => ({}))) as {
    embeddings?: GeminiEmbedding[];
    error?: { message?: string };
    metadata?: { billableCharacterCount?: number };
  };
  if (!response.ok) {
    throw new AppError(data.error?.message || 'Gemini embeddings failed', 502);
  }
  const vectors = (data.embeddings ?? []).map((item) => item.values ?? []);
  if (vectors.length !== texts.length || vectors.some((vector) => vector.length === 0)) {
    throw new AppError('Gemini did not return an embedding for every chunk', 502);
  }
  const wrong = vectors.find((vector) => vector.length !== GEMINI_EMBEDDING_DIMENSIONS);
  if (wrong) {
    throw new AppError(
      `Gemini returned embeddings of length ${wrong.length}. Knowra expects ${GEMINI_EMBEDDING_DIMENSIONS}.`,
      502,
    );
  }
  const estimated = texts.reduce((sum, text) => sum + estimateTokens(text), 0);
  return {
    vectors,
    usage: { promptTokens: estimated, completionTokens: 0, totalTokens: estimated },
  };
}

export async function geminiEmbedDocuments(
  apiKey: string,
  texts: string[],
  onProgress?: (completed: number, total: number) => void | Promise<void>,
): Promise<EmbeddingsResult> {
  if (texts.length === 0) return { embeddings: [], usage: emptyUsage() };
  const batchSize = 64;
  const embeddings: number[][] = [];
  let usage = emptyUsage();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const result = await embedBatch(apiKey, batch, 'RETRIEVAL_DOCUMENT');
    embeddings.push(...result.vectors);
    usage = {
      promptTokens: usage.promptTokens + result.usage.promptTokens,
      completionTokens: usage.completionTokens + result.usage.completionTokens,
      totalTokens: usage.totalTokens + result.usage.totalTokens,
    };
    await onProgress?.(Math.min(texts.length, embeddings.length), texts.length);
  }
  return { embeddings, usage };
}

export async function geminiEmbedQuery(apiKey: string, text: string): Promise<EmbeddingResult> {
  const result = await embedBatch(apiKey, [text], 'RETRIEVAL_QUERY');
  const embedding = result.vectors[0];
  if (!embedding) throw new AppError('Gemini did not return a query embedding', 502);
  return { embedding, usage: result.usage };
}
