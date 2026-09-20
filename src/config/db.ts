import mongoose from 'mongoose';
import { env } from './env.js';

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (!connecting) {
    mongoose.set('strictQuery', true);
    connecting = mongoose.connect(env.MONGODB_URI).finally(() => {
      connecting = null;
    });
  }

  await connecting;
  console.log('Connected to MongoDB');
}
