import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { connectDatabase } from './config/db.js';
import { configureCloudinary } from './services/cloudinary/storage.js';
import { startJobWorker } from './services/jobs/worker.js';
import { ensureChunkVectorIndex } from './services/rag/ensureVectorIndex.js';
import { AppError, errorHandler } from './utils/errors.js';
import routes from './routes/index.js';

async function main() {
  await connectDatabase();
  configureCloudinary();

  if (mongoose.connection.db) {
    await ensureChunkVectorIndex(mongoose.connection);
  }

  const app = express();

  // Render / reverse proxies set X-Forwarded-For; required for express-rate-limit
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CLIENT_ORIGIN,
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));

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

  startJobWorker();

  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`Knowra API listening on http://0.0.0.0:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
