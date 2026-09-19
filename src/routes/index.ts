import { Router } from 'express';
import authRoutes from './auth.js';
import settingsRoutes from './settings.js';
import documentsRoutes from './documents.js';
import conversationsRoutes from './conversations.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'knowra-api' });
});

router.use('/auth', authRoutes);
router.use('/settings', settingsRoutes);
router.use('/documents', documentsRoutes);
router.use('/conversations', conversationsRoutes);

export default router;
