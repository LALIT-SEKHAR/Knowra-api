import app from './app.js';
import { env } from './config/env.js';
import { startJobWorker } from './services/jobs/worker.js';

const isServerless = process.env.VERCEL === '1';

if (!isServerless) {
  startJobWorker();
  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`Knowra API listening on http://0.0.0.0:${env.PORT}`);
  });
}

export default app;
