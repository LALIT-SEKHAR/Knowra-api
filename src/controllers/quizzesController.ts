import type { Response } from 'express';
import { z } from 'zod';
import type { AuthedRequest } from '../middleware/auth.js';
import { scoreQuiz } from '../services/tutor/quizStore.js';
import { asyncHandler } from '../utils/errors.js';

const attemptSchema = z.object({
  answers: z.array(z.number().int()).min(1).max(8),
});

export const submitQuizHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = attemptSchema.parse(req.body);
  const quiz = await scoreQuiz({
    quizId: String(req.params.id),
    userId: req.user!._id.toString(),
    workspace: req.workspace!,
    answers: body.answers,
  });
  res.json({ quiz });
});
