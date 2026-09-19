import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
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
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests. Try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification attempts. Try again later.' },
});

router.post('/request-otp', otpLimiter, requestOtpHandler);
router.post('/verify-otp', verifyLimiter, verifyOtpHandler);
router.get('/me', requireAuth, meHandler);
router.patch('/me', requireAuth, updateProfileHandler);
router.post('/me/avatar', requireAuth, avatarUpload.single('avatar'), uploadAvatarHandler);
router.delete('/me/avatar', requireAuth, deleteAvatarHandler);
router.post('/logout', requireAuth, logoutHandler);

export default router;
