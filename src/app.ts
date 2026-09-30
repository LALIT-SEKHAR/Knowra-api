import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import dns from 'node:dns';
import { env } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { configureCloudinary } from './services/cloudinary/storage.js';
import { ensureChunkVectorIndex } from './services/rag/ensureVectorIndex.js';
import { AppError, errorHandler } from './utils/errors.js';
import routes from './routes/index.js';

// Prefer IPv4 (some hosts cannot reach external APIs over IPv6)
dns.setDefaultResultOrder('ipv4first');

const app = express();

app.set('trust proxy', 1);

const clientOrigins = env.CLIENT_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    referrerPolicy: { policy: 'no-referrer' },
  }),
);
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});
app.use(
  cors({
    origin: clientOrigins.length <= 1 ? clientOrigins[0] : clientOrigins,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'OPTIONS' || req.path === '/' || req.path === '/api/health',
    message: { error: 'Too many requests. Try again in a minute.' },
  }),
);

let ready: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await connectDatabase();
      configureCloudinary();
      if (mongoose.connection.db) {
        await ensureChunkVectorIndex(mongoose.connection);
      }
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  await ready;
}

app.use((req, res, next) => {
  void ensureReady()
    .then(() => next())
    .catch(next);
});

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'knowra-api',
    health: '/api/health',
    app: 'https://knowra-cyan.vercel.app',
  });
});

app.use('/api', routes);

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Validation failed',
      details: err.flatten(),
    });
    return;
  }
  if (err instanceof Error && err.message === 'File too large') {
    next(new AppError('File exceeds maximum upload size', 400));
    return;
  }
  errorHandler(err, req, res, next);
});

export default app;
