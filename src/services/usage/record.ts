import { UsageDaily } from '../../models/UsageDaily.js';

export type UsageDelta = {
  uploads?: number;
  ocrPages?: number;
  ocrTokens?: number;
  embeddings?: number;
  embeddingTokens?: number;
  chunks?: number;
  chats?: number;
  chatTokens?: number;
  aiCalls?: number;
};

export type UsageTotals = Required<UsageDelta>;

const EMPTY_TOTALS: UsageTotals = {
  uploads: 0,
  ocrPages: 0,
  ocrTokens: 0,
  embeddings: 0,
  embeddingTokens: 0,
  chunks: 0,
  chats: 0,
  chatTokens: 0,
  aiCalls: 0,
};

/** UTC YYYY-MM-DD for a Date (defaults to now). */
export function utcDayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function emptyUsageTotals(): UsageTotals {
  return { ...EMPTY_TOTALS };
}

export function addUsageTotals(a: UsageTotals, b: Partial<UsageTotals>): UsageTotals {
  return {
    uploads: a.uploads + (b.uploads ?? 0),
    ocrPages: a.ocrPages + (b.ocrPages ?? 0),
    ocrTokens: a.ocrTokens + (b.ocrTokens ?? 0),
    embeddings: a.embeddings + (b.embeddings ?? 0),
    embeddingTokens: a.embeddingTokens + (b.embeddingTokens ?? 0),
    chunks: a.chunks + (b.chunks ?? 0),
    chats: a.chats + (b.chats ?? 0),
    chatTokens: a.chatTokens + (b.chatTokens ?? 0),
    aiCalls: a.aiCalls + (b.aiCalls ?? 0),
  };
}

/** Rough activity score used for the contribution heat map. */
export function usageActivityScore(totals: Partial<UsageTotals>): number {
  return (
    (totals.uploads ?? 0) * 3 +
    (totals.ocrPages ?? 0) +
    (totals.embeddings ?? 0) +
    (totals.chunks ?? 0) +
    (totals.chats ?? 0) * 4 +
    Math.round(((totals.chatTokens ?? 0) + (totals.embeddingTokens ?? 0) + (totals.ocrTokens ?? 0)) / 1000)
  );
}

/**
 * Atomically bump today's usage counters for a user.
 * Failures are logged but never thrown — usage must not break product flows.
 */
export async function recordUsage(userId: string, delta: UsageDelta): Promise<void> {
  const entries = Object.entries(delta).filter(
    ([, value]) => typeof value === 'number' && value !== 0,
  ) as Array<[keyof UsageDelta, number]>;
  if (entries.length === 0) return;

  const $inc: Record<string, number> = {};
  for (const [key, value] of entries) {
    $inc[key] = value;
  }

  try {
    const date = utcDayKey();
    await UsageDaily.findOneAndUpdate(
      { userId, date },
      {
        $inc,
        $setOnInsert: { userId, date },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.error('Failed to record usage', err);
  }
}

export function sumDocsToTotals(
  docs: Array<Partial<UsageTotals>>,
): UsageTotals {
  return docs.reduce<UsageTotals>((acc, doc) => addUsageTotals(acc, doc), emptyUsageTotals());
}
