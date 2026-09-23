import type { Response } from 'express';
import { asyncHandler } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { UsageDaily } from '../models/UsageDaily.js';
import {
  emptyUsageTotals,
  sumDocsToTotals,
  usageActivityScore,
  utcDayKey,
  type UsageTotals,
} from '../services/usage/record.js';
import { getStorageUsage } from '../services/usage/storage.js';

const LOOKBACK_DAYS = 371; // ~53 weeks so the GitHub-style grid fills evenly

function shiftUtcDay(dayKey: string, deltaDays: number): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return utcDayKey(date);
}

function intensityLevel(score: number, maxScore: number): 0 | 1 | 2 | 3 | 4 {
  if (score <= 0 || maxScore <= 0) return 0;
  const ratio = score / maxScore;
  if (ratio <= 0.2) return 1;
  if (ratio <= 0.4) return 2;
  if (ratio <= 0.7) return 3;
  return 4;
}

function sliceTotals(days: Array<{ date: string } & UsageTotals>, fromKey: string): UsageTotals {
  return sumDocsToTotals(days.filter((d) => d.date >= fromKey));
}

export const getUsageHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const userId = req.user!._id;
  const today = utcDayKey();
  const start = shiftUtcDay(today, -(LOOKBACK_DAYS - 1));

  const [rows, storage] = await Promise.all([
    UsageDaily.find({
      userId,
      date: { $gte: start, $lte: today },
    })
      .sort({ date: 1 })
      .lean(),
    getStorageUsage(userId),
  ]);

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const daily: Array<{ date: string; level: 0 | 1 | 2 | 3 | 4; score: number } & UsageTotals> = [];

  for (let i = 0; i < LOOKBACK_DAYS; i += 1) {
    const date = shiftUtcDay(start, i);
    const row = byDate.get(date);
    const totals = row
      ? {
          uploads: row.uploads ?? 0,
          ocrPages: row.ocrPages ?? 0,
          ocrTokens: row.ocrTokens ?? 0,
          embeddings: row.embeddings ?? 0,
          embeddingTokens: row.embeddingTokens ?? 0,
          chunks: row.chunks ?? 0,
          chats: row.chats ?? 0,
          chatTokens: row.chatTokens ?? 0,
          aiCalls: row.aiCalls ?? 0,
        }
      : emptyUsageTotals();
    const score = usageActivityScore(totals);
    daily.push({ date, score, level: 0, ...totals });
  }

  const maxScore = Math.max(0, ...daily.map((d) => d.score));
  for (const day of daily) {
    day.level = intensityLevel(day.score, maxScore);
  }

  const weekStart = shiftUtcDay(today, -6);
  const monthStart = shiftUtcDay(today, -29);

  const periods = {
    day: sliceTotals(daily, today),
    week: sliceTotals(daily, weekStart),
    month: sliceTotals(daily, monthStart),
    year: sumDocsToTotals(daily),
  };

  const totals = periods.year;

  res.json({
    storage,
    totals,
    periods,
    daily: daily.map(({ date, level, score, ...metrics }) => ({
      date,
      level,
      score,
      ...metrics,
    })),
    range: { start, end: today },
  });
});
