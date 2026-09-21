import OpenAI from 'openai';
import { EMBEDDING_MODEL, OCR_MODEL } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type EmbeddingResult = {
  embedding: number[];
  usage: TokenUsage;
};

export type EmbeddingsResult = {
  embeddings: number[][];
  usage: TokenUsage;
};

export type OcrResult = {
  text: string;
  usage: TokenUsage;
};

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

function fromOpenAIUsage(usage?: {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
} | null): TokenUsage {
  if (!usage) return emptyUsage();
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/** Fallback when providers omit usage — ~4 chars per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function createOpenAIClient(apiKey: string, baseURL?: string): OpenAI {
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export async function validateOpenAIKey(apiKey: string, baseURL?: string): Promise<boolean> {
  const client = createOpenAIClient(apiKey, baseURL);
  await client.models.list();
  return true;
}

export async function createEmbedding(apiKey: string, text: string): Promise<EmbeddingResult> {
  const client = createOpenAIClient(apiKey);
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new AppError('Failed to generate embedding', 502);
  }
  const usage = fromOpenAIUsage(response.usage);
  if (usage.totalTokens === 0) {
    usage.promptTokens = estimateTokens(text);
    usage.totalTokens = usage.promptTokens;
  }
  return { embedding, usage };
}

export async function createEmbeddings(
  apiKey: string,
  texts: string[],
  onProgress?: (completed: number, total: number) => void | Promise<void>,
): Promise<EmbeddingsResult> {
  if (texts.length === 0) return { embeddings: [], usage: emptyUsage() };
  const client = createOpenAIClient(apiKey);
  const batchSize = 64;
  const results: number[][] = [];
  let usage = emptyUsage();
  const total = texts.length;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
    });
    const sorted = [...response.data].sort((a, b) => a.index - b.index);
    for (const item of sorted) {
      results.push(item.embedding);
    }
    const batchUsage = fromOpenAIUsage(response.usage);
    if (batchUsage.totalTokens === 0) {
      const estimated = batch.reduce((sum, text) => sum + estimateTokens(text), 0);
      batchUsage.promptTokens = estimated;
      batchUsage.totalTokens = estimated;
    }
    usage = addUsage(usage, batchUsage);
    await onProgress?.(Math.min(total, results.length), total);
  }

  return { embeddings: results, usage };
}

const OCR_PROMPT =
  'Extract all readable text from this document page image. Preserve reading order, headings, lists, and mathematical notation as plain text. Return only the extracted text with no commentary. If the page has no readable text, return an empty string.';

export async function extractTextFromImage(apiKey: string, dataUrl: string): Promise<OcrResult> {
  const client = createOpenAIClient(apiKey);
  const response = await client.chat.completions.create({
    model: OCR_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '';
  const usage = fromOpenAIUsage(response.usage);
  if (usage.totalTokens === 0) {
    const estimated = estimateTokens(OCR_PROMPT) + estimateTokens(text) + 1000;
    usage.promptTokens = estimated;
    usage.completionTokens = estimateTokens(text);
    usage.totalTokens = estimated;
  }
  return { text, usage };
}
