import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { processAvailableJobs } from '../services/jobs/worker.js';

const router = Router();

function bearerMatches(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ') || !secret) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(secret);
  if (presented.length !== expected.length) {
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, expected);
}

/** Vercel Cron (and manual) job drain — keeps PDF processing moving on serverless. */
router.get('/jobs', async (req, res) => {
  const secret = env.CRON_SECRET;
  if (env.NODE_ENV === 'production' && !secret) {
    res.status(503).json({ error: 'Cron is not configured' });
    return;
  }
  if (secret && !bearerMatches(req.headers.authorization, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const processed = await processAvailableJobs(10);
  res.json({ ok: true, processed });
});

export default router;
