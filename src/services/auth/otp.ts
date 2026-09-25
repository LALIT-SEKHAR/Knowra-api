import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import { Otp, type OtpPurpose } from '../../models/Otp.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/errors.js';
import { sendOtpEmail } from '../mail/mailer.js';
import { signToken } from '../../middleware/auth.js';
import { cancelAccountDeletion } from '../user/purge.js';
import { createOrganization, joinOrganization } from '../orgs/workspace.js';

const MAX_ATTEMPTS = 5;

export type OtpRequestResult = {
  expiresAt: Date;
  resendAvailableAt: Date;
};

async function createAndSendOtp(email: string, purpose: OtpPurpose): Promise<OtpRequestResult> {
  const normalized = email.trim().toLowerCase();
  const cooldownMs = env.OTP_RESEND_COOLDOWN_SECONDS * 1000;

  const recent = await Otp.findOne({ email: normalized, purpose }).sort({ createdAt: -1 });
  if (recent?.createdAt) {
    const createdAt = new Date(recent.createdAt).getTime();
    const retryAt = createdAt + cooldownMs;
    if (retryAt > Date.now()) {
      const retryAfterSeconds = Math.ceil((retryAt - Date.now()) / 1000);
      throw new AppError(
        `Please wait ${retryAfterSeconds}s before requesting another code.`,
        429,
        { retryAfterSeconds, resendAvailableAt: new Date(retryAt).toISOString() },
      );
    }
  }

  const code = String(randomInt(100000, 999999));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

  await Otp.deleteMany({ email: normalized, purpose, consumed: false });
  await Otp.create({
    email: normalized,
    purpose,
    codeHash,
    expiresAt,
    attempts: 0,
    consumed: false,
  });
  await sendOtpEmail(normalized, code, purpose);

  return {
    expiresAt,
    resendAvailableAt: new Date(Date.now() + cooldownMs),
  };
}

async function consumeOtp(email: string, code: string, purpose: OtpPurpose): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const normalizedCode = code.replace(/\s+/g, '');

  // Legacy login OTPs may omit `purpose`; treat those as login.
  const otp =
    purpose === 'login'
      ? await Otp.findOne({
          email: normalized,
          consumed: false,
          $or: [{ purpose: 'login' }, { purpose: { $exists: false } }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any).sort({ createdAt: -1 })
      : await Otp.findOne({ email: normalized, purpose, consumed: false }).sort({
          createdAt: -1,
        });

  if (!otp) {
    throw new AppError('Invalid or expired code', 400);
  }

  if (otp.expiresAt.getTime() < Date.now()) {
    throw new AppError('Invalid or expired code', 400);
  }

  if ((otp.attempts ?? 0) >= MAX_ATTEMPTS) {
    throw new AppError('Too many attempts. Request a new code.', 429);
  }

  const ok = await bcrypt.compare(normalizedCode, otp.codeHash);
  if (!ok) {
    otp.attempts = (otp.attempts ?? 0) + 1;
    await otp.save();
    throw new AppError('Invalid or expired code', 400);
  }

  otp.consumed = true;
  await otp.save();
}

export async function requestOtp(email: string): Promise<OtpRequestResult> {
  return createAndSendOtp(email, 'login');
}

export async function requestDeleteAccountOtp(email: string): Promise<OtpRequestResult> {
  return createAndSendOtp(email, 'delete_account');
}

export async function verifyDeleteAccountOtp(email: string, code: string): Promise<void> {
  await consumeOtp(email, code, 'delete_account');
}

export async function requestDeleteFilesOtp(email: string): Promise<OtpRequestResult> {
  return createAndSendOtp(email, 'delete_files');
}

export async function verifyDeleteFilesOtp(email: string, code: string): Promise<void> {
  await consumeOtp(email, code, 'delete_files');
}

export async function verifyOtp(
  email: string,
  code: string,
  options?: { orgName?: string; joinSlug?: string },
): Promise<{
  token: string;
  isNew: boolean;
  deletionCancelled: boolean;
  user: {
    id: string;
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    deletionScheduledFor?: string | null;
  };
}> {
  const normalized = email.trim().toLowerCase();
  await consumeOtp(normalized, code, 'login');

  let user = await User.findOne({ email: normalized });
  const isNew = !user;
  if (!user) {
    user = await User.create({ email: normalized });
  }

  const orgName = options?.orgName?.trim();
  const joinSlug = options?.joinSlug?.trim();
  if (orgName) {
    await createOrganization(user, orgName);
    user = (await User.findById(user._id)) ?? user;
  } else if (joinSlug) {
    await joinOrganization(user, joinSlug);
    user = (await User.findById(user._id)) ?? user;
  }

  const deletionCancelled = await cancelAccountDeletion(user._id.toString());
  // cancelAccountDeletion reloads fields; refresh local doc
  user = (await User.findById(user._id)) ?? user;

  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken({ userId: user._id.toString(), email: user.email });

  return {
    token,
    isNew,
    deletionCancelled,
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? null,
      deletionScheduledFor: null,
    },
  };
}
