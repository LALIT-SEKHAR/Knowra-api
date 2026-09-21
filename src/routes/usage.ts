import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getUsageHandler } from '../controllers/usageController.js';

const router = Router();

router.get('/', requireAuth, getUsageHandler);

export default router;
