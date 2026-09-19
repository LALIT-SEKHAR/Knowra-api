import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { encryptSecret, lastFour } from '../utils/crypto.js';
import { validateOpenAIKey } from '../services/openai/client.js';

const keySchema = z.object({
  apiKey: z.string().min(20),
});

export const getSettingsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  res.json({
    hasOpenAIKey: Boolean(user.openaiApiKeyEncrypted),
    openaiKeyLast4: user.openaiKeyLast4 ?? null,
  });
});

export const putOpenAIKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = keySchema.parse(req.body);
  try {
    await validateOpenAIKey(body.apiKey);
  } catch {
    throw new AppError('Invalid OpenAI API key', 400);
  }

  const user = req.user!;
  user.openaiApiKeyEncrypted = encryptSecret(body.apiKey);
  user.openaiKeyLast4 = lastFour(body.apiKey);
  await user.save();

  res.json({
    hasOpenAIKey: true,
    openaiKeyLast4: user.openaiKeyLast4,
  });
});

export const deleteOpenAIKeyHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  user.openaiApiKeyEncrypted = undefined;
  user.openaiKeyLast4 = undefined;
  await user.save();
  res.json({ hasOpenAIKey: false, openaiKeyLast4: null });
});
