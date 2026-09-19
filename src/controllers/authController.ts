import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requestOtp, verifyOtp } from '../services/auth/otp.js';

const emailSchema = z.object({
  email: z.string().email(),
});

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
});

export const requestOtpHandler = asyncHandler(async (req, res) => {
  const body = emailSchema.parse(req.body);
  await requestOtp(body.email);
  res.json({ ok: true, message: 'If the email is valid, a code has been sent.' });
});

export const verifyOtpHandler = asyncHandler(async (req, res) => {
  const body = verifySchema.parse(req.body);
  const result = await verifyOtp(body.email, body.code);
  res.json(result);
});

export const meHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  res.json({
    id: user._id.toString(),
    email: user.email,
    name: user.name ?? null,
    hasOpenAIKey: Boolean(user.openaiApiKeyEncrypted),
    openaiKeyLast4: user.openaiKeyLast4 ?? null,
  });
});

export const logoutHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});
