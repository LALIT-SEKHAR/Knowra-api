import { Router } from 'express';
import authRoutes from './auth.js';
import orgRoutes from './orgs.js';
import settingsRoutes from './settings.js';
import documentsRoutes from './documents.js';
import conversationsRoutes from './conversations.js';
import quizzesRoutes from './quizzes.js';
import usageRoutes from './usage.js';
import cronRoutes from './cron.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'knowra-api' });
});

router.use('/auth', authRoutes);
router.use('/orgs', orgRoutes);
router.use('/settings', settingsRoutes);
router.use('/documents', documentsRoutes);
router.use('/conversations', conversationsRoutes);
router.use('/quizzes', quizzesRoutes);
router.use('/usage', usageRoutes);
router.use('/cron', cronRoutes);

export default router;
