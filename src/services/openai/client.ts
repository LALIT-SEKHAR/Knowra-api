import OpenAI from 'openai';
import { CHAT_MODEL, EMBEDDING_MODEL } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

export async function validateOpenAIKey(apiKey: string): Promise<boolean> {
  const client = createOpenAIClient(apiKey);
  await client.models.list();
  return true;
}

export async function createEmbedding(apiKey: string, text: string): Promise<number[]> {
  const client = createOpenAIClient(apiKey);
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new AppError('Failed to generate embedding', 502);
  }
  return embedding;
}

export async function createEmbeddings(apiKey: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const client = createOpenAIClient(apiKey);
  const batchSize = 64;
  const results: number[][] = [];

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
  }

  return results;
}

export async function generateChatAnswer(
  apiKey: string,
  params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  },
): Promise<string> {
  const client = createOpenAIClient(apiKey);
  const response = await client.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    messages: [{ role: 'system', content: params.system }, ...params.messages],
  });
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new AppError('Failed to generate answer', 502);
  }
  return content;
}
