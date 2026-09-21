import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  clearChatsHandler,
  cancelDeleteAccountHandler,
  deleteAccountHandler,
  deleteAllFilesHandler,
  deleteOpenAIKeyHandler,
  deleteProviderKeyHandler,
  getSettingsHandler,
  putChatModelHandler,
  putChatPrefsHandler,
  putOpenAIKeyHandler,
  putProviderKeyHandler,
  requestDeleteAccountOtpHandler,
  requestDeleteFilesOtpHandler,
} from '../controllers/settingsController.js';

const router = Router();

const deleteAccountOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many deletion code requests. Try again later.' },
  keyGenerator: (req) => {
    const userId = (req as AuthedRequest).user?._id?.toString();
    return userId ? `delete-otp:${userId}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

const deleteAccountVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account deletion attempts. Try again later.' },
  keyGenerator: (req) => {
    const userId = (req as AuthedRequest).user?._id?.toString();
    return userId ? `delete-verify:${userId}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

const deleteFilesOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many deletion code requests. Try again later.' },
  keyGenerator: (req) => {
    const userId = (req as AuthedRequest).user?._id?.toString();
    return userId ? `delete-files-otp:${userId}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

const deleteFilesVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many file deletion attempts. Try again later.' },
  keyGenerator: (req) => {
    const userId = (req as AuthedRequest).user?._id?.toString();
    return userId ? `delete-files-verify:${userId}` : ipKeyGenerator(req.ip ?? 'unknown');
  },
});

router.use(requireAuth);
router.get('/', getSettingsHandler);
router.put('/openai-key', putOpenAIKeyHandler);
router.delete('/openai-key', deleteOpenAIKeyHandler);
router.put('/chat-prefs', putChatPrefsHandler);
router.put('/chat-model', putChatModelHandler);
router.put('/provider-key', putProviderKeyHandler);
router.delete('/provider-key/:provider', deleteProviderKeyHandler);
router.delete('/chats', clearChatsHandler);
router.post('/files/request-otp', deleteFilesOtpLimiter, requestDeleteFilesOtpHandler);
router.delete('/files', deleteFilesVerifyLimiter, deleteAllFilesHandler);
router.post('/account/request-otp', deleteAccountOtpLimiter, requestDeleteAccountOtpHandler);
router.delete('/account', deleteAccountVerifyLimiter, deleteAccountHandler);
router.post('/account/cancel', cancelDeleteAccountHandler);

export default router;
