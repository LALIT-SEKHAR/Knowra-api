import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import { Otp } from '../../models/Otp.js';
import { User } from '../../models/User.js';
import { AppError } from '../../utils/errors.js';
import { sendOtpEmail } from '../mail/mailer.js';
import { signToken } from '../../middleware/auth.js';

const MAX_ATTEMPTS = 5;

export async function requestOtp(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const code = String(randomInt(100000, 999999));
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + env.OTP_EXPIRY_MINUTES * 60 * 1000);

  await Otp.deleteMany({ email: normalized, consumed: false });
  await Otp.create({ email: normalized, codeHash, expiresAt, attempts: 0, consumed: false });
  await sendOtpEmail(normalized, code);
}

export async function verifyOtp(
  email: string,
  code: string,
): Promise<{ token: string; user: { id: string; email: string; name?: string | null } }> {
  const normalized = email.trim().toLowerCase();
  const normalizedCode = code.replace(/\s+/g, '');
  const otp = await Otp.findOne({ email: normalized, consumed: false }).sort({ createdAt: -1 });

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

  let user = await User.findOne({ email: normalized });
  if (!user) {
    user = await User.create({ email: normalized });
  }
  user.lastLoginAt = new Date();
  await user.save();

  const token = signToken({ userId: user._id.toString(), email: user.email });

  return {
    token,
    user: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
    },
  };
}
