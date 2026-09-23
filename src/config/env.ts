import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  SMTP_FROM: z.string().default('Knowra <noreply@knowra.app>'),
  /** Public HTTPS logo URL for emails. Avoids Gmail attachment chips from CID embeds. */
  EMAIL_LOGO_URL: z.string().optional().default(''),
  RESEND_API_KEY: z.string().optional().default(''),
  CRON_SECRET: z.string().optional().default(''),
  OTP_EXPIRY_MINUTES: z.coerce.number().default(10),
  /** Minimum seconds between OTP send/resend for the same email+purpose. */
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().default(60),
  MAX_UPLOAD_BYTES: z.coerce.number().default(1024 * 1024 * 1024),
  VECTOR_INDEX_NAME: z.string().default('chunk_embedding_index'),
  NODE_ENV: z.string().default('development'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/** Free-plan Cloudinary rejects a single raw object above 10 MiB. */
export const CLOUDINARY_OBJECT_MAX_BYTES = 10 * 1024 * 1024;
/** Part size used when a PDF is split so each object stays under that cap. */
export const CLOUDINARY_PART_BYTES = 9 * 1024 * 1024;
export const MAX_PDF_PARTS = 120;

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
/** Fixed for document indexing — do not expose as a user preference. */
export const OCR_MODEL = 'gpt-4o-mini';

export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 200;
export const OCR_MAX_PAGES = 40;
/** One page at a time so vision calls don't refill the tokens-per-minute cap. */
export const OCR_CONCURRENCY = 1;
/** Grace period after confirmed deletion request before data is purged. */
export const ACCOUNT_DELETION_GRACE_DAYS = 7;
