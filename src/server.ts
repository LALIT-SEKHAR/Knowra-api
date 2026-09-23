import app from './app.js';
import { connectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { startJobWorker } from './services/jobs/worker.js';

const isServerless = process.env.VERCEL === '1';

if (!isServerless) {
  void connectDatabase()
    .then(() => {
      startJobWorker();
      app.listen(env.PORT, '0.0.0.0', () => {
        console.log(`Knowra API listening on http://0.0.0.0:${env.PORT}`);
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to connect to MongoDB:', message.replace(/\/\/[^@\s]+@/g, '//***@'));
      process.exit(1);
    });
}

export default app;
