import { Router } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import {
  deleteAvatarHandler,
  logoutHandler,
  meHandler,
  requestOtpHandler,
  updateProfileHandler,
  uploadAvatarHandler,
  verifyOtpHandler,
} from '../controllers/authController.js';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Try again later.' },
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `otp-request:${email}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Try again later.' },
  keyGenerator: (req) => {
    const email =
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `otp-verify:${email}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

router.post('/request-otp', otpLimiter, requestOtpHandler);
router.post('/verify-otp', verifyLimiter, verifyOtpHandler);
router.get('/me', requireAuth, meHandler);
router.patch('/me', requireAuth, updateProfileHandler);
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), uploadAvatarHandler);
router.delete('/me/avatar', requireAuth, deleteAvatarHandler);
router.post('/logout', requireAuth, logoutHandler);

export default router;
