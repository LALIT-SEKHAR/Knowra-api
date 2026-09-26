import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { DocumentModel } from '../models/Document.js';
import { FolderModel } from '../models/Folder.js';
import {
  assertFolderOwned,
  createUserFolder,
  deleteUserFolder,
  ensureFolderPath,
  pathToFolder,
  resolveBrowse,
  serializeFolder,
  updateUserFolder,
  type FolderPathSegment,
} from '../services/documents/folders.js';
import { CLOUDINARY_OBJECT_MAX_BYTES, env, MAX_PDF_PARTS } from '../config/env.js';
import { isDocumentMime, isOfficeMime, mimeFromFilename } from '../services/documents/fileTypes.js';
import { previewOfficePages } from '../services/documents/office.js';
import {
  assertOwnedPdfPublicId,
  cloudinaryIdsOf,
  cloudinaryUrlsOf,
  createPdfUploadSignature,
  deleteCloudinaryFile,
  downloadCloudinaryFiles,
  pipeCloudinaryFiles,
  uploadPdfInParts,
} from '../services/cloudinary/storage.js';
import { enqueueJob } from '../services/jobs/worker.js';
import { chatWithDocument } from '../services/rag/chat.js';
import { recordUsage } from '../services/usage/record.js';
import { libraryFilter } from '../services/orgs/workspace.js';

function owned(req: AuthedRequest) {
  return libraryFilter(req.workspace!, req.user!._id);
}

export const mentionableFilesHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const docs = await DocumentModel.find({
    ...owned(req),
    status: 'ready',
  })
    .select('name')
    .sort({ name: 1 })
    .limit(200);
  res.json({
    files: docs.map((doc) => ({ id: doc._id.toString(), name: doc.name })),
  });
});

function serializeDocument(
  doc: InstanceType<typeof DocumentModel>,
  path?: FolderPathSegment[],
) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    mimeType: doc.mimeType,
    size: doc.size,
    cloudinaryUrl: doc.cloudinaryUrl,
    folderId: doc.folderId ? doc.folderId.toString() : null,
    status: doc.status,
    errorMessage: doc.errorMessage ?? null,
    pageCount: doc.pageCount ?? null,
    progress: typeof doc.progress === 'number' ? doc.progress : null,
    stage: doc.stage ?? null,
    processingStartedAt: doc.processingStartedAt
      ? doc.processingStartedAt.toISOString()
      : null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...(path ? { path } : {}),
  };
}

function nameMatcher(q: string) {
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

const folderIdSchema = z.union([z.string().min(1), z.null()]);

export const listDocumentsHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const folderParam = typeof req.query.folder === 'string' ? req.query.folder.trim() : '';
  const userId = req.user!._id;
  const scope = owned(req);
  const orgId = req.workspace?.orgId ?? null;

  if (!folderParam) {
    const filter: Record<string, unknown> = { ...scope };
    if (q) filter.name = nameMatcher(q);
    const docs = await DocumentModel.find(filter).sort({ updatedAt: -1 });
    res.json({ documents: docs.map((doc) => serializeDocument(doc)) });
    return;
  }

  const browse = await resolveBrowse(userId, folderParam, orgId);
  const breadcrumb = browse.currentId ? pathToFolder(browse.currentId, browse.byId) : [];

  if (!q) {
    const childFolders = browse.folders
      .filter((folder) => (folder.parentId ? folder.parentId.toString() : null) === browse.currentId)
      .sort((a, b) => a.name.localeCompare(b.name));
    const docs = await DocumentModel.find({
      ...scope,
      folderId: browse.currentId ?? null,
    }).sort({ updatedAt: -1 });
    res.json({
      folders: childFolders.map((folder) => serializeFolder(folder)),
      documents: docs.map((doc) => serializeDocument(doc)),
      breadcrumb,
    });
    return;
  }

  const matcher = nameMatcher(q);
  const matchedFolders = browse.folders
    .filter((folder) => matcher.test(folder.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const docs = await DocumentModel.find({ ...scope, name: matcher }).sort({ updatedAt: -1 });

  res.json({
    folders: matchedFolders.map((folder) => {
      const parentPath = folder.parentId ? pathToFolder(folder.parentId.toString(), browse.byId) : [];
      return serializeFolder(folder, parentPath);
    }),
    documents: docs.map((doc) =>
      serializeDocument(
        doc,
        doc.folderId ? pathToFolder(doc.folderId.toString(), browse.byId) : [],
      ),
    ),
    breadcrumb,
  });
});

export const listFoldersHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const folders = await FolderModel.find(owned(req)).sort({ name: 1 });
  res.json({ folders: folders.map((folder) => serializeFolder(folder)) });
});

const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: folderIdSchema.optional(),
});

export const createFolderHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = createFolderSchema.parse(req.body);
  const folder = await createUserFolder(req.user!._id, body.name, body.parentId ?? null, req.workspace?.orgId);
  res.status(201).json({ folder: serializeFolder(folder) });
});

const ensureFolderSchema = z.object({
  parentId: folderIdSchema.optional(),
  segments: z.array(z.string().min(1).max(120)).min(1).max(8),
});

export const ensureFolderHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = ensureFolderSchema.parse(req.body);
  const folder = await ensureFolderPath(
    req.user!._id,
    body.parentId ?? null,
    body.segments,
    req.workspace?.orgId,
  );
  res.json({ folder: serializeFolder(folder) });
});

const updateFolderSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    parentId: folderIdSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, {
    message: 'Nothing to update',
  });

export const updateFolderHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = updateFolderSchema.parse(req.body);
  const folder = await updateUserFolder(req.user!._id, String(req.params.id), body, req.workspace?.orgId);
  res.json({ folder: serializeFolder(folder) });
});

export const deleteFolderHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const result = await deleteUserFolder(req.user!._id, String(req.params.id), req.workspace?.orgId);
  res.json({ ok: true, ...result });
});

export const getDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);
  res.json({ document: serializeDocument(doc) });
});

export const uploadSignatureHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const keys = req.workspace?.org ?? user;
  if (!keys.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings before uploading', 400);
  }

  const filename =
    typeof req.query.filename === 'string' ? req.query.filename.trim() : '';
  if (!filename) throw new AppError('filename is required', 400);
  if (!mimeFromFilename(filename)) {
    throw new AppError('Only PDF, Word, Excel, and image files are supported', 400);
  }

  const part = typeof req.query.part === 'string' ? Number(req.query.part) : 0;
  if (!Number.isInteger(part) || part < 0 || part >= MAX_PDF_PARTS) {
    throw new AppError('Invalid upload part', 400);
  }

  res.json({
    upload: createPdfUploadSignature(filename, user._id.toString(), part),
  });
});

const uploadPartSchema = z.object({
  cloudinaryPublicId: z.string().min(1),
  cloudinaryUrl: z.string().url(),
  bytes: z.number().int().positive().max(CLOUDINARY_OBJECT_MAX_BYTES),
});

const registerUploadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive().max(env.MAX_UPLOAD_BYTES),
  mimeType: z.enum([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
  ]),
  cloudinaryPublicId: z.string().min(1).optional(),
  cloudinaryUrl: z.string().url().optional(),
  parts: z.array(uploadPartSchema).min(1).max(MAX_PDF_PARTS).optional(),
  folderId: folderIdSchema.optional(),
});

const abortUploadSchema = z.object({
  publicIds: z.array(z.string().min(1)).min(1).max(MAX_PDF_PARTS),
});

export const uploadDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const user = req.user!;
  const keys = req.workspace?.org ?? user;
  if (!keys.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings before uploading', 400);
  }

  // Preferred path: file already on Cloudinary (avoids serverless body limits).
  if (!req.file) {
    const body = registerUploadSchema.parse(req.body);
    const parts = body.parts?.length
      ? body.parts
      : body.cloudinaryPublicId && body.cloudinaryUrl
        ? [{
            cloudinaryPublicId: body.cloudinaryPublicId,
            cloudinaryUrl: body.cloudinaryUrl,
            bytes: body.size,
          }]
        : null;
    if (!parts) throw new AppError('Upload location is required', 400);
    const namedMime = mimeFromFilename(body.name);
    if (namedMime && namedMime !== body.mimeType) {
      throw new AppError('Only PDF, Word, Excel, and image files are supported', 400);
    }
    if (!namedMime && !isDocumentMime(body.mimeType)) {
      throw new AppError('Only PDF, Word, Excel, and image files are supported', 400);
    }
    if (body.parts?.length) {
      const total = parts.reduce((sum, part) => sum + part.bytes, 0);
      if (total !== body.size) throw new AppError('Upload size does not match file parts', 400);
    }
    for (const part of parts) {
      assertOwnedPdfPublicId(part.cloudinaryPublicId, user._id.toString());
    }
    const first = parts[0]!;
    const folder = await assertFolderOwned(user._id, body.folderId, req.workspace?.orgId);

    const doc = await DocumentModel.create({
      userId: user._id,
      orgId: req.workspace?.orgId ?? null,
      name: body.name,
      mimeType: body.mimeType,
      size: body.size,
      cloudinaryPublicId: first.cloudinaryPublicId,
      cloudinaryUrl: first.cloudinaryUrl,
      cloudinaryParts: parts.map((part) => ({
        publicId: part.cloudinaryPublicId,
        url: part.cloudinaryUrl,
      })),
      folderId: folder?._id ?? null,
      status: 'processing',
      progress: 0,
      stage: 'queued',
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
  const mimeType = mimeFromFilename(file.originalname) ?? (isDocumentMime(file.mimetype) ? file.mimetype : null);
  if (!mimeType) {
    throw new AppError('Only PDF, Word, Excel, and image files are supported', 400);
  }
  if (file.size > env.MAX_UPLOAD_BYTES) {
    throw new AppError('File exceeds maximum upload size', 400);
  }

  const uploaded = await uploadPdfInParts(file.buffer, file.originalname, user._id.toString());
  const first = uploaded[0];
  if (!first) throw new AppError('Upload failed', 400);
  const requestedFolderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
  const folder = await assertFolderOwned(user._id, requestedFolderId, req.workspace?.orgId);

  const doc = await DocumentModel.create({
    userId: user._id,
    orgId: req.workspace?.orgId ?? null,
    name: file.originalname,
    mimeType,
    size: file.size,
    cloudinaryPublicId: first.publicId,
    cloudinaryUrl: first.url,
    cloudinaryParts: uploaded.map((part) => ({
      publicId: part.publicId,
      url: part.url,
    })),
    folderId: folder?._id ?? null,
    status: 'processing',
    progress: 0,
    stage: 'queued',
  });

  await enqueueJob('process_document', {
    documentId: doc._id.toString(),
    userId: user._id.toString(),
  });

  await recordUsage(user._id.toString(), { uploads: 1 });

  res.status(202).json({ document: serializeDocument(doc) });
});

const renameSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    folderId: folderIdSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.folderId !== undefined, {
    message: 'Nothing to update',
  });

export const renameDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = renameSchema.parse(req.body);
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);
  if (body.name !== undefined) doc.name = body.name.trim();
  if (body.folderId !== undefined) {
    const folder = await assertFolderOwned(req.user!._id, body.folderId);
    doc.folderId = folder?._id ?? null;
  }
  await doc.save();
  res.json({ document: serializeDocument(doc) });
});

export const deleteDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);

  const documentId = doc._id.toString();
  const userId = req.user!._id.toString();

  doc.status = 'processing';
  await doc.save();

  await enqueueJob('delete_document', {
    documentId,
    userId,
    cloudinaryPublicId: doc.cloudinaryPublicId,
    cloudinaryPublicIds: cloudinaryIdsOf(doc),
  });

  res.json({ ok: true, message: 'Document deletion queued' });
});

export const retryDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);
  if (doc.status !== 'failed') {
    throw new AppError('Only failed documents can be retried', 400);
  }

  const keys = req.workspace?.org ?? req.user!;
  if (!keys.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings first', 400);
  }

  doc.status = 'processing';
  doc.errorMessage = undefined;
  doc.progress = 0;
  doc.stage = 'queued';
  doc.processingStartedAt = undefined;
  await doc.save();

  await enqueueJob('process_document', {
    documentId: doc._id.toString(),
    userId: req.user!._id.toString(),
  });

  res.json({ document: serializeDocument(doc) });
});

export const abortUploadHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = abortUploadSchema.parse(req.body);
  const userId = req.user!._id.toString();
  for (const publicId of body.publicIds) {
    assertOwnedPdfPublicId(publicId, userId);
  }

  const saved = await DocumentModel.find({
    ...owned(req),
    $or: [
      { cloudinaryPublicId: { $in: body.publicIds } },
      { 'cloudinaryParts.publicId': { $in: body.publicIds } },
    ],
  }).select('cloudinaryPublicId cloudinaryParts');
  const kept = new Set(saved.flatMap((doc) => cloudinaryIdsOf(doc)));

  await Promise.all(
    body.publicIds
      .filter((publicId) => !kept.has(publicId))
      .map((publicId) => deleteCloudinaryFile(publicId).catch(() => undefined)),
  );

  res.json({ ok: true });
});

const OFFICE_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export const previewDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);
  if (!isOfficeMime(doc.mimeType)) {
    throw new AppError('Preview is only available for Word and Excel files', 400);
  }
  if (doc.size > OFFICE_PREVIEW_MAX_BYTES) {
    res.json({ pages: [], tooLarge: true });
    return;
  }

  try {
    const buffer = await downloadCloudinaryFiles(cloudinaryUrlsOf(doc));
    const pages = await previewOfficePages(buffer, doc.mimeType);
    res.json({
      pages: pages.map((page) => ({ pageNumber: page.pageNumber, html: page.html })),
      tooLarge: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This file could not be read.';
    throw new AppError(message, 422);
  }
});

export const downloadDocumentHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const doc = await DocumentModel.findOne({ _id: req.params.id, ...owned(req) });
  if (!doc) throw new AppError('Document not found', 404);

  const urls = cloudinaryUrlsOf(doc);
  res.setHeader('Content-Type', isDocumentMime(doc.mimeType) ? doc.mimeType : 'application/octet-stream');
  res.setHeader('Content-Length', String(doc.size));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(doc.name)}"`,
  );
  res.setHeader('Cache-Control', 'private, max-age=300');
  await pipeCloudinaryFiles(urls, res);
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
    workspace: req.workspace!,
  });
  res.json(result);
});
