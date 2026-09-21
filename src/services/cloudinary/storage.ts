import { v2 as cloudinary } from 'cloudinary';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/errors.js';

let configured = false;

export function configureCloudinary(): void {
  if (configured) return;
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return;
  }
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

function assertConfigured(): void {
  configureCloudinary();
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    throw new AppError('Cloudinary is not configured', 503);
  }
}

export async function uploadPdfBuffer(
  buffer: Buffer,
  filename: string,
  userId: string,
): Promise<{ publicId: string; url: string; bytes: number }> {
  assertConfigured();

  const safeBase = filename
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  const publicId = `${safeBase}_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        folder: `knowra/${userId}`,
        public_id: publicId,
        overwrite: false,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary upload failed'));
          return;
        }
        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          bytes: result.bytes,
        });
      },
    );
    stream.end(buffer);
  });
}

/** Signed params for browser → Cloudinary direct upload (avoids Vercel body limits). */
export function createPdfUploadSignature(
  filename: string,
  userId: string,
): {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  publicId: string;
  signature: string;
  resourceType: 'raw';
} {
  assertConfigured();

  const timestamp = Math.round(Date.now() / 1000);
  const safeBase = filename
    .replace(/\.pdf$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  const publicId = `${safeBase}_${timestamp}`;
  const folder = `knowra/${userId}`;

  const signature = cloudinary.utils.api_sign_request(
    { folder, public_id: publicId, timestamp },
    env.CLOUDINARY_API_SECRET,
  );

  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    timestamp,
    folder,
    publicId,
    signature,
    resourceType: 'raw',
  };
}

export function assertOwnedPdfPublicId(publicId: string, userId: string): void {
  const expectedPrefix = `knowra/${userId}/`;
  if (!publicId.startsWith(expectedPrefix)) {
    throw new AppError('Invalid upload target', 400);
  }
}

export async function deleteCloudinaryFile(publicId: string): Promise<void> {
  assertConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
}

const ALLOWED_AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function isAllowedAvatarMime(mime: string): boolean {
  return ALLOWED_AVATAR_MIME.has(mime);
}

export async function uploadAvatarBuffer(
  buffer: Buffer,
  filename: string,
  userId: string,
): Promise<{ publicId: string; url: string; bytes: number }> {
  assertConfigured();

  const safeBase = filename
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 60);
  const publicId = `avatar_${safeBase}_${Date.now()}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        folder: `knowra/${userId}/avatars`,
        public_id: publicId,
        overwrite: true,
        // Client already square-crops; resize only so face gravity doesn't reframe.
        transformation: [{ width: 256, height: 256, crop: 'limit' }],
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('Cloudinary avatar upload failed'));
          return;
        }
        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          bytes: result.bytes,
        });
      },
    );
    stream.end(buffer);
  });
}

export async function deleteCloudinaryImage(publicId: string): Promise<void> {
  assertConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
}

export async function downloadCloudinaryFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AppError('Failed to download document from storage', 502);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
