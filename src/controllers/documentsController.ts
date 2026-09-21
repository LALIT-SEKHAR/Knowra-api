import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { DocumentModel } from '../models/Document.js';
import { env } from '../config/env.js';
import {
  assertOwnedPdfPublicId,
  createPdfUploadSignature,
  uploadPdfBuffer,
} from '../services/cloudinary/storage.js';
import { enqueueJob } from '../services/jobs/worker.js';
import { chatWithDocument } from '../services/rag/chat.js';
import { recordUsage } from '../services/usage/record.js';

function serializeDocument(doc: InstanceType<typeof DocumentModel>) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    cloudinaryUrl: doc.cloudinaryUrl,
    status: doc.status,
    errorMessage: doc.errorMessage ?? null,
    pageCount: doc.pageCount ?? null,
    progress: typeof doc.progress === 'number' ? doc.progress : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const listDocumentsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const filter: Record<string, unknown> = { userId: req.user!._id };
  if (q) {
    filter.name = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }
  const docs = await DocumentModel.find(filter).sort({ updatedAt: -1 });
  res.json({ documents: docs.map(serializeDocument) });
});

export const getDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!doc) throw new AppError('Document not found', 404);
  res.json({ document: serializeDocument(doc) });
});

export const uploadSignatureHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (!user.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings before uploading', 400);
  }

  const filename =
    typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
  if (!filename) throw new AppError('filename is required', 400);
  if (!/\.pdf$/i.test(filename)) {
    throw new AppError('Only PDF files are supported', 400);
  }

  res.json({
    upload: createPdfUploadSignature(filename, user._id.toString()),
  });
});

const registerUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
  mimeType: z.literal('application/pdf'),
  cloudinaryPublicId: z.string().min(1),
  cloudinaryUrl: z.string().url(),
});

export const uploadDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  if (!user.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings before uploading', 400);
  }

  // Preferred path: file already on Cloudinary (avoids serverless body limits).
  if (!req.file) {
    const body = registerUploadSchema.parse(req.body);
    assertOwnedPdfPublicId(body.cloudinaryPublicId, user._id.toString());

    const doc = await DocumentModel.create({
      userId: user._id,
      name: body.name,
      mimeType: body.mimeType,
      size: body.size,
      cloudinaryPublicId: body.cloudinaryPublicId,
      cloudinaryUrl: body.cloudinaryUrl,
      status: 'processing',
      progress: 0,
    });

    await enqueueJob('process_document', {
      documentId: doc._id.toString(),
      userId: user._id.toString(),
    });

    await recordUsage(user._id.toString(), { uploads: 1 });

    res.status(202).json({ document: serializeDocument(doc) });
    return;
  }

  const file = req.file;
  if (file.mimetype !== 'application/pdf') {
    throw new AppError('Only PDF files are supported', 400);
  }
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw new AppError('File exceeds maximum upload size', 400);
  }

  const uploaded = await uploadPdfBuffer(file.buffer, file.originalname, user._id.toString());

  const doc = await DocumentModel.create({
    userId: user._id,
    name: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    cloudinaryPublicId: uploaded.publicId,
    cloudinaryUrl: uploaded.url,
    status: 'processing',
    progress: 0,
  });

  await enqueueJob('process_document', {
    documentId: doc._id.toString(),
    userId: user._id.toString(),
  });

  await recordUsage(user._id.toString(), { uploads: 1 });

  res.status(202).json({ document: serializeDocument(doc) });
});

const renameSchema = z.object({
  name: z.string().min(1).max(255),
});

export const renameDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = renameSchema.parse(req.body);
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!doc) throw new AppError('Document not found', 404);
  doc.name = body.name.trim();
  await doc.save();
  res.json({ document: serializeDocument(doc) });
});

export const deleteDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!doc) throw new AppError('Document not found', 404);

  const publicId = doc.cloudinaryPublicId;
  const documentId = doc._id.toString();
  const userId = req.user!._id.toString();

  doc.status = 'processing';
  await doc.save();

  await enqueueJob('delete_document', {
    documentId,
    userId,
    cloudinaryPublicId: publicId,
  });

  res.json({ ok: true, message: 'Document deletion queued' });
});

export const retryDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!doc) throw new AppError('Document not found', 404);
  if (doc.status !== 'failed') {
    throw new AppError('Only failed documents can be retried', 400);
  }

  if (!req.user!.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings first', 400);
  }

  doc.status = 'processing';
  doc.errorMessage = undefined;
  doc.progress = 0;
  await doc.save();

  await enqueueJob('process_document', {
    documentId: doc._id.toString(),
    userId: req.user!._id.toString(),
  });

  res.json({ document: serializeDocument(doc) });
});

export const downloadDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, userId: req.user!._id });
  if (!doc) throw new AppError('Document not found', 404);

  const response = await fetch(doc.cloudinaryUrl);
  if (!response.ok) {
    throw new AppError('Failed to fetch document file', 502);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(doc.name)}"`,
  );
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(buffer);
});

const chatSchema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
});

export const chatDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = chatSchema.parse(req.body);
  const documentId = String(req.params.id);
  const result = await chatWithDocument({
    userId: req.user!._id.toString(),
    documentId,
    question: body.question,
    conversationId: body.conversationId,
  });
  res.json(result);
});
