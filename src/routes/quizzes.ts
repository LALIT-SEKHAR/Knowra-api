import { Router } from 'express';
import { submitQuizHandler } from '../controllers/quizzesController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.use(requireAuth);
router.post('/:id/attempts', submitQuizHandler);

export default router;
