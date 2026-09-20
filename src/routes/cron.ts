import { Router } from 'express';
import { env } from '../config/env.js';
import { processAvailableJobs } from '../services/jobs/worker.js';

const router = Router();

/** Vercel Cron (and manual) job drain — keeps PDF processing moving on serverless. */
router.get('/jobs', async (req, res) => {
  const auth = req.headers.authorization;
  const secret = env.CRON_SECRET;
  if (secret) {
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const processed = await processAvailableJobs(10);
  res.json({ ok: true, processed });
});

export default router;
