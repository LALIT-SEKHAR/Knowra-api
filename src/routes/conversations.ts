import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  chatHandler,
  deleteConversationHandler,
  getConversationHandler,
  listConversationsHandler,
} from '../controllers/conversationsController.js';

const router = Router();

router.use(requireAuth);
router.get('/', listConversationsHandler);
router.post('/chat', chatHandler);
router.get('/:id', getConversationHandler);
router.delete('/:id', deleteConversationHandler);

export default router;
