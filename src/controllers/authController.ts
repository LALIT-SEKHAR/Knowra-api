import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requestOtp, verifyOtp } from '../services/auth/otp.js';
import type { UserDocument } from '../models/User.js';
import {
  deleteCloudinaryImage,
  isAllowedAvatarMime,
  uploadAvatarBuffer,
} from '../services/cloudinary/storage.js';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const emailSchema = z.object({
  email: z.string().email(),
});

const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(10),
});

const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .max(80)
    .optional()
    .nullable()
    .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : v)),
});

export function serializeUser(user: UserDocument) {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name ?? null,
    avatarUrl: user.avatarUrl ?? null,
    hasOpenAIKey: Boolean(user.openaiApiKeyEncrypted),
    openaiKeyLast4: user.openaiKeyLast4 ?? null,
  };
}

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
  res.json(serializeUser(req.user!));
});

export const updateProfileHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const body = updateProfileSchema.parse(req.body);

  if (body.name !== undefined) {
    user.name = body.name ?? undefined;
  }

  await user.save();
  res.json(serializeUser(user));
});

export const uploadAvatarHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const file = req.file;

  if (!file) {
    throw new AppError('Image file is required', 400);
  }
  if (!isAllowedAvatarMime(file.mimetype)) {
    throw new AppError('Avatar must be a JPEG, PNG, WebP, or GIF image', 400);
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new AppError('Avatar must be 2MB or smaller', 400);
  }

  const previousPublicId = user.avatarPublicId;
  const uploaded = await uploadAvatarBuffer(file.buffer, file.originalname, user._id.toString());

  user.avatarUrl = uploaded.url;
  user.avatarPublicId = uploaded.publicId;
  await user.save();

  if (previousPublicId && previousPublicId !== uploaded.publicId) {
    try {
      await deleteCloudinaryImage(previousPublicId);
    } catch {
      // Best-effort cleanup of previous avatar
    }
  }

  res.json(serializeUser(user));
});

export const deleteAvatarHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const previousPublicId = user.avatarPublicId;

  user.avatarUrl = undefined;
  user.avatarPublicId = undefined;
  await user.save();

  if (previousPublicId) {
    try {
      await deleteCloudinaryImage(previousPublicId);
    } catch {
      // Best-effort cleanup
    }
  }

  res.json(serializeUser(user));
});

export const logoutHandler = asyncHandler(async (_req, res) => {
  res.json({ ok: true });
});
