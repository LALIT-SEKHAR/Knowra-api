import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  deleteOpenAIKeyHandler,
  getSettingsHandler,
  putOpenAIKeyHandler,
} from '../controllers/settingsController.js';

const router = Router();

router.use(requireAuth);
router.get('/', getSettingsHandler);
router.put('/openai-key', putOpenAIKeyHandler);
router.delete('/openai-key', deleteOpenAIKeyHandler);

export default router;
