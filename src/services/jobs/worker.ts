import { Job, type JobType } from '../../models/Job.js';
import { DocumentModel } from '../../models/Document.js';
import { Chunk } from '../../models/Chunk.js';
import { Conversation } from '../../models/Conversation.js';
import { Message } from '../../models/Message.js';
import { User } from '../../models/User.js';
import { decryptSecret } from '../../utils/crypto.js';
import {
  cloudinaryUrlsOf,
  deleteCloudinaryFile,
  downloadCloudinaryFiles,
} from '../cloudinary/storage.js';
import { isExcelMime, isImageMime, isWordMime } from '../documents/fileTypes.js';
import { extractOfficePages } from '../documents/office.js';
import { chunkPages, extractPdfPages, type PageText } from '../documents/parser.js';
import { ocrPdfPages, ocrStandaloneImage } from '../documents/ocr.js';
import { createEmbeddings } from '../openai/client.js';
import { purgeUserDataCompletely } from '../user/purge.js';
import { recordUsage } from '../usage/record.js';

const WORKER_ID = `worker-${process.pid}`;
const POLL_MS = 2000;

export async function enqueueJob(
  type: JobType,
  payload: Record<string, unknown>,
  options?: { nextRunAt?: Date },
): Promise<void> {
  await Job.create({
    type,
    payload,
    status: 'pending',
    attempts: 0,
    nextRunAt: options?.nextRunAt ?? new Date(),
  });
  scheduleBackgroundProcessing();
}

/** Drain up to `limit` pending jobs (used on Vercel via waitUntil / cron). */
export async function processAvailableJobs(limit = 5): Promise<number> {
  let processed = 0;
  while (processed < limit) {
    const job = await claimNextJob();
    if (!job) break;
    await handleJob(job);
    processed += 1;
  }
  return processed;
}

function scheduleBackgroundProcessing(): void {
  if (process.env.VERCEL !== '1') {
    return;
  }

  const run = () =>
    processAvailableJobs(5).catch((err) => {
      console.error('Background job processing failed', err);
    });

  void import('@vercel/functions')
    .then(({ waitUntil }) => {
      waitUntil(run());
    })
    .catch(() => {
      void run();
    });
}

async function claimNextJob() {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      status: { $in: ['pending', 'failed'] },
      nextRunAt: { $lte: now },
      $expr: { $lt: ['$attempts', '$maxAttempts'] },
    },
    {
      $set: {
        status: 'processing',
        lockedAt: now,
        lockedBy: WORKER_ID,
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1 }, returnDocument: 'after' },
  );
}

async function processDocumentJob(payload: { documentId: string; userId: string }) {
  const document = await DocumentModel.findOne({
    _id: payload.documentId,
    userId: payload.userId,
  });
  if (!document) {
    throw new Error('Document not found');
  }

  const user = await User.findById(payload.userId);
  if (!user?.openaiApiKeyEncrypted) {
    document.status = 'failed';
    document.errorMessage = 'OpenAI API key is required in Settings before processing';
    await document.save();
    return;
  }

  const setProgress = async (
    value: number,
    stage: 'downloading' | 'reading' | 'extracting' | 'indexing' | 'finishing',
  ) => {
    document.progress = Math.max(0, Math.min(100, Math.round(value)));
    document.stage = stage;
    await document.save();
  };

  document.status = 'processing';
  document.errorMessage = undefined;
  document.progress = 5;
  document.stage = 'downloading';
  document.processingStartedAt = new Date();
  await document.save();

  const buffer = await downloadCloudinaryFiles(cloudinaryUrlsOf(document));
  await setProgress(12, 'reading');
  const apiKey = decryptSecret(user.openaiApiKeyEncrypted);

  let pages: PageText[];
  let ocrPages = 0;
  let ocrTokens = 0;
  let ocrAiCalls = 0;
  const image = isImageMime(document.mimeType);
  const office = isWordMime(document.mimeType) || isExcelMime(document.mimeType);
  try {
    if (image) {
      await setProgress(20, 'extracting');
      const ocr = await ocrStandaloneImage(buffer, apiKey);
      pages = ocr.pages;
      ocrPages = ocr.pageCount;
      ocrTokens = ocr.usage.totalTokens;
      ocrAiCalls = 1;
      await setProgress(55, 'extracting');
    } else if (office) {
      await setProgress(20, 'extracting');
      pages = await extractOfficePages(buffer, document.mimeType);
      await setProgress(55, 'extracting');
    } else {
      pages = await extractPdfPages(buffer);
      if (pages.length === 0) {
        const ocr = await ocrPdfPages(buffer, apiKey, async ({ completedPages, totalPages }) => {
          const ratio = totalPages > 0 ? completedPages / totalPages : 1;
          await setProgress(15 + ratio * 50, 'extracting');
        });
        pages = ocr.pages;
        ocrPages = ocr.pageCount;
        ocrTokens = ocr.usage.totalTokens;
        ocrAiCalls = ocr.pageCount;
      } else {
        await setProgress(55, 'reading');
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not read this file';
    const rateLimited = /\b429\b/.test(message) || /rate limit/i.test(message);
    if (rateLimited) {
      document.status = 'processing';
      document.errorMessage = undefined;
      await document.save();
      throw err;
    }
    document.status = 'failed';
    document.errorMessage = message;
    await document.save();
    return;
  }

  await setProgress(65, 'indexing');
  const textChunks = chunkPages(pages);

  if (textChunks.length === 0) {
    document.status = 'failed';
    document.errorMessage = image
      ? 'No readable text found in this image.'
      : isExcelMime(document.mimeType)
        ? 'No readable text found in this spreadsheet.'
        : isWordMime(document.mimeType)
          ? 'No readable text found in this document.'
          : 'No readable text found in this PDF, even after OCR. Try a clearer scan or a text-based PDF.';
    await document.save();
    return;
  }

  const embeddingsResult = await createEmbeddings(
    apiKey,
    textChunks.map((c) => c.content),
    async (completed, total) => {
      const ratio = total > 0 ? completed / total : 1;
      await setProgress(65 + ratio * 30, 'indexing');
    },
  );

  await setProgress(96, 'finishing');

  await Chunk.deleteMany({ documentId: document._id });

  const docs = textChunks.map((chunk, index) => ({
    documentId: document._id,
    userId: document.userId,
    content: chunk.content,
    embedding: embeddingsResult.embeddings[index],
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
  }));

  await Chunk.insertMany(docs);

  document.status = 'ready';
  document.pageCount = pages.length;
  document.progress = 100;
  document.stage = undefined;
  document.errorMessage = undefined;
  await document.save();

  const embeddingBatches = Math.max(1, Math.ceil(textChunks.length / 64));
  await recordUsage(payload.userId, {
    ocrPages,
    ocrTokens,
    embeddings: embeddingsResult.embeddings.length,
    embeddingTokens: embeddingsResult.usage.totalTokens,
    chunks: textChunks.length,
    aiCalls: ocrAiCalls + embeddingBatches,
  });
}

async function deleteDocumentJob(payload: {
  documentId: string;
  userId: string;
  cloudinaryPublicId?: string;
  cloudinaryPublicIds?: string[];
}) {
  const { documentId, userId } = payload;
  const publicIds = [
    ...new Set(
      [...(payload.cloudinaryPublicIds ?? []), payload.cloudinaryPublicId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];

  for (const publicId of publicIds) {
    try {
      await deleteCloudinaryFile(publicId);
    } catch (err) {
      console.error('Cloudinary delete failed, will retry', err);
      throw err;
    }
  }

  await Chunk.deleteMany({ documentId, userId });

  const conversations = await Conversation.find({ documentId, userId }).select('_id');
  const conversationIds = conversations.map((c) => c._id);
  if (conversationIds.length > 0) {
    await Message.deleteMany({ conversationId: { $in: conversationIds } });
    await Conversation.deleteMany({ _id: { $in: conversationIds } });
  }

  await DocumentModel.deleteOne({ _id: documentId, userId });
}

async function handleJob(job: Awaited<ReturnType<typeof claimNextJob>>) {
  if (!job) return;

  try {
    if (job.type === 'process_document') {
      await processDocumentJob(job.payload as { documentId: string; userId: string });
    } else if (job.type === 'delete_document') {
      await deleteDocumentJob(
        job.payload as {
          documentId: string;
          userId: string;
          cloudinaryPublicId?: string;
          cloudinaryPublicIds?: string[];
        },
      );
    } else if (job.type === 'purge_account') {
      const { userId } = job.payload as { userId: string };
      const user = await User.findById(userId);
      // Skip if cancelled or rescheduled further out
      if (
        user?.deletionScheduledFor &&
        user.deletionScheduledFor.getTime() <= Date.now()
      ) {
        await purgeUserDataCompletely(userId);
      }
    }

    job.status = 'completed';
    job.lastError = undefined;
    await job.save();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown job error';
    job.lastError = message;
    const attempts = job.attempts ?? 1;
    const maxAttempts = job.maxAttempts ?? 5;
    const rateLimited = /\b429\b/.test(message) || /rate limit/i.test(message);
    const publicMessage = rateLimited
      ? 'OpenAI rate limit was reached while reading this file. Retry it in a minute.'
      : message;

    if (attempts >= maxAttempts) {
      job.status = 'failed';
      const payload = job.payload as { documentId?: string };
      if (payload.documentId && job.type === 'process_document') {
        await DocumentModel.findByIdAndUpdate(payload.documentId, {
          status: 'failed',
          errorMessage: publicMessage,
        });
      }
      if (payload.documentId && job.type === 'delete_document') {
        await DocumentModel.findByIdAndUpdate(payload.documentId, {
          $set: {
            status: 'failed',
            errorMessage: 'Could not delete this file. Try again from Files.',
          },
          $unset: { folderId: 1 },
        });
      }
    } else {
      job.status = 'pending';
      const backoffMs = rateLimited
        ? Math.min(60_000, 15_000 * attempts)
        : Math.min(60_000, 2 ** attempts * 1000);
      job.nextRunAt = new Date(Date.now() + backoffMs);
    }
    await job.save();
  }
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const job = await claimNextJob();
    if (job) {
      await handleJob(job);
    }
  } catch (err) {
    console.error('Job worker tick failed', err);
  } finally {
    running = false;
  }
}

export function startJobWorker(): void {
  if (process.env.VERCEL === '1') {
    console.log('Job worker: serverless mode (waitUntil / cron)');
    return;
  }
  if (timer) return;
  console.log('Job worker started');
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  void tick();
}

export function stopJobWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
