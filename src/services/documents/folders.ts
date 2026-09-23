import mongoose from 'mongoose';
import { FolderModel, type FolderDocument } from '../../models/Folder.js';
import { DocumentModel } from '../../models/Document.js';
import { AppError } from '../../utils/errors.js';
import { cloudinaryIdsOf } from '../cloudinary/storage.js';
import { enqueueJob } from '../jobs/worker.js';

export const MAX_FOLDER_DEPTH = 8;
const MAX_FOLDER_NAME = 120;

export type FolderPathSegment = { id: string; name: string };

export type FolderRecord = {
  _id: mongoose.Types.ObjectId;
  name: string;
  parentId?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

export function serializeFolder(folder: FolderRecord, path?: FolderPathSegment[]) {
  return {
    id: folder._id.toString(),
    name: folder.name,
    parentId: folder.parentId ? folder.parentId.toString() : null,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
    ...(path ? { path } : {}),
  };
}

export function normalizeFolderName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > MAX_FOLDER_NAME) {
    throw new AppError(`Folder name must be 1–${MAX_FOLDER_NAME} characters`, 400);
  }
  if (trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed) || /[\u0000-\u001f]/.test(trimmed)) {
    throw new AppError('Folder names cannot include slashes', 400);
  }
  return trimmed;
}

export function folderNameKey(name: string): string {
  return normalizeFolderName(name).toLowerCase();
}

export function buildFolderIndex(folders: FolderRecord[]) {
  const byId = new Map<string, FolderRecord>();
  const childIds = new Map<string, string[]>();
  for (const folder of folders) {
    const id = folder._id.toString();
    byId.set(id, folder);
    const parentKey = folder.parentId ? folder.parentId.toString() : 'root';
    const list = childIds.get(parentKey) ?? [];
    list.push(id);
    childIds.set(parentKey, list);
  }
  return { byId, childIds };
}

export function pathToFolder(folderId: string, byId: Map<string, FolderRecord>): FolderPathSegment[] {
  const path: FolderPathSegment[] = [];
  const seen = new Set<string>();
  let current: string | null = folderId;
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const folder = byId.get(current);
    if (!folder) break;
    path.push({ id: current, name: folder.name });
    current = folder.parentId ? folder.parentId.toString() : null;
  }
  path.reverse();
  return path;
}

export function descendantIds(rootId: string, childIds: Map<string, string[]>): string[] {
  const out: string[] = [];
  const stack = [...(childIds.get(rootId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const child of childIds.get(id) ?? []) stack.push(child);
  }
  return out;
}

function depthOf(folderId: string | null, byId: Map<string, FolderRecord>): number {
  if (!folderId) return 0;
  let depth = 0;
  let current: string | null = folderId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) throw new AppError('Folder structure is invalid', 400);
    seen.add(current);
    const parent = byId.get(current);
    if (!parent) throw new AppError('Folder not found', 404);
    depth += 1;
    const parentId = parent.parentId;
    current = parentId ? parentId.toString() : null;
    if (depth > MAX_FOLDER_DEPTH) break;
  }
  return depth;
}

function subtreeHeight(folderId: string, childIds: Map<string, string[]>): number {
  const children = childIds.get(folderId) ?? [];
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((child) => subtreeHeight(child, childIds)));
}

async function loadUserFolders(userId: mongoose.Types.ObjectId | string) {
  return FolderModel.find({ userId });
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;
}

async function assertUniqueSibling(
  userId: mongoose.Types.ObjectId | string,
  parentId: string | null,
  name: string,
  excludeId?: string,
) {
  const existing = await FolderModel.findOne({
    userId,
    parentId: parentId ?? null,
    nameKey: folderNameKey(name),
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select('_id');
  if (existing) throw new AppError('A folder with that name already exists here', 409);
}

export async function assertFolderOwned(
  userId: mongoose.Types.ObjectId | string,
  folderId: string | null | undefined,
) {
  if (!folderId) return null;
  if (!mongoose.isValidObjectId(folderId)) throw new AppError('Folder not found', 404);
  const folder = await FolderModel.findOne({ _id: folderId, userId });
  if (!folder) throw new AppError('Folder not found', 404);
  return folder;
}

export async function resolveBrowse(userId: mongoose.Types.ObjectId, folderParam: string) {
  const folders = await loadUserFolders(userId);
  const index = buildFolderIndex(folders);
  if (folderParam === 'root') {
    return { folders, ...index, currentId: null as string | null };
  }
  if (!mongoose.isValidObjectId(folderParam) || !index.byId.has(folderParam)) {
    throw new AppError('Folder not found', 404);
  }
  return { folders, ...index, currentId: folderParam };
}

export async function createUserFolder(
  userId: mongoose.Types.ObjectId,
  name: string,
  parentId: string | null,
): Promise<FolderDocument> {
  const clean = normalizeFolderName(name);
  const folders = await loadUserFolders(userId);
  const { byId } = buildFolderIndex(folders);
  if (parentId) {
    if (!mongoose.isValidObjectId(parentId) || !byId.has(parentId)) {
      throw new AppError('Folder not found', 404);
    }
    if (depthOf(parentId, byId) >= MAX_FOLDER_DEPTH) {
      throw new AppError(`Folders can only be nested ${MAX_FOLDER_DEPTH} levels deep`, 400);
    }
  }
  await assertUniqueSibling(userId, parentId, clean);
  try {
    return await FolderModel.create({
      userId,
      name: clean,
      nameKey: folderNameKey(clean),
      parentId: parentId ? new mongoose.Types.ObjectId(parentId) : null,
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('A folder with that name already exists here', 409);
    throw err;
  }
}

export async function ensureFolderPath(
  userId: mongoose.Types.ObjectId,
  parentId: string | null,
  segments: string[],
): Promise<FolderDocument> {
  if (segments.length < 1 || segments.length > MAX_FOLDER_DEPTH) {
    throw new AppError(`Folder paths can be at most ${MAX_FOLDER_DEPTH} levels deep`, 400);
  }
  let currentParent = parentId;
  let leaf: FolderDocument | null = null;
  for (const segment of segments) {
    const clean = normalizeFolderName(segment);
    const existing = await FolderModel.findOne({
      userId,
      parentId: currentParent ?? null,
      nameKey: folderNameKey(clean),
    });
    if (existing) {
      leaf = existing;
      currentParent = existing._id.toString();
      continue;
    }
    try {
      leaf = await createUserFolder(userId, clean, currentParent);
    } catch (err) {
      if (!(err instanceof AppError) || err.statusCode !== 409) throw err;
      const raced = await FolderModel.findOne({
        userId,
        parentId: currentParent ?? null,
        nameKey: folderNameKey(clean),
      });
      if (!raced) throw err;
      leaf = raced;
    }
    currentParent = leaf._id.toString();
  }
  if (!leaf) throw new AppError('Folder path is empty', 400);
  return leaf;
}

export async function updateUserFolder(
  userId: mongoose.Types.ObjectId,
  folderId: string,
  patch: { name?: string; parentId?: string | null },
): Promise<FolderDocument> {
  if (!mongoose.isValidObjectId(folderId)) throw new AppError('Folder not found', 404);
  const folder = await FolderModel.findOne({ _id: folderId, userId });
  if (!folder) throw new AppError('Folder not found', 404);

  const folders = await loadUserFolders(userId);
  const { byId, childIds } = buildFolderIndex(folders);
  let nextParent = folder.parentId ? folder.parentId.toString() : null;

  if (patch.parentId !== undefined) {
    nextParent = patch.parentId;
    if (nextParent === folderId) throw new AppError('A folder cannot be moved into itself', 400);
    if (nextParent) {
      if (!mongoose.isValidObjectId(nextParent) || !byId.has(nextParent)) {
        throw new AppError('Folder not found', 404);
      }
      const blocked = new Set([folderId, ...descendantIds(folderId, childIds)]);
      if (blocked.has(nextParent)) {
        throw new AppError('A folder cannot be moved into itself', 400);
      }
    }
    const nextDepth = depthOf(nextParent, byId) + subtreeHeight(folderId, childIds);
    if (nextDepth > MAX_FOLDER_DEPTH) {
      throw new AppError(`Folders can only be nested ${MAX_FOLDER_DEPTH} levels deep`, 400);
    }
  }

  const nextName = patch.name !== undefined ? normalizeFolderName(patch.name) : folder.name;
  if (nextName !== folder.name || nextParent !== (folder.parentId ? folder.parentId.toString() : null)) {
    await assertUniqueSibling(userId, nextParent, nextName, folderId);
  }

  folder.name = nextName;
  folder.nameKey = folderNameKey(nextName);
  folder.parentId = nextParent ? new mongoose.Types.ObjectId(nextParent) : null;
  try {
    await folder.save();
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('A folder with that name already exists here', 409);
    throw err;
  }
  return folder;
}

export async function deleteUserFolder(userId: mongoose.Types.ObjectId, folderId: string) {
  if (!mongoose.isValidObjectId(folderId)) throw new AppError('Folder not found', 404);
  const folders = await loadUserFolders(userId);
  const { byId, childIds } = buildFolderIndex(folders);
  if (!byId.has(folderId)) throw new AppError('Folder not found', 404);

  const ids = [folderId, ...descendantIds(folderId, childIds)];
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const docs = await DocumentModel.find({ userId, folderId: { $in: objectIds } });

  if (docs.length > 0) {
    await DocumentModel.updateMany(
      { userId, _id: { $in: docs.map((doc) => doc._id) } },
      { status: 'processing' },
    );
    for (const doc of docs) {
      await enqueueJob('delete_document', {
        documentId: doc._id.toString(),
        userId: userId.toString(),
        cloudinaryPublicId: doc.cloudinaryPublicId,
        cloudinaryPublicIds: cloudinaryIdsOf(doc),
      });
    }
  }

  await FolderModel.deleteMany({ userId, _id: { $in: objectIds } });
  return { deletedFolders: ids.length, deletedDocuments: docs.length };
}
