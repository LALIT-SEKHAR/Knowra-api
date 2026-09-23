import type { Types } from 'mongoose';
import { Chunk } from '../../models/Chunk.js';
import { DocumentModel } from '../../models/Document.js';

export type StorageUsage = {
  /** Files currently kept for this user. */
  files: number;
  /** Sum of original upload sizes stored in cloud storage. */
  fileBytes: number;
  /** Chunk documents currently stored for this user. */
  chunks: number;
  /** BSON size of those chunk documents, including text and embeddings. */
  chunkBytes: number;
  /** Cloud files plus chunk documents. */
  totalBytes: number;
};

export async function getStorageUsage(userId: Types.ObjectId): Promise<StorageUsage> {
  const [fileRows, chunkRows] = await Promise.all([
    DocumentModel.aggregate<{ files: number; fileBytes: number | null }>([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          files: { $sum: 1 },
          fileBytes: { $sum: '$size' },
        },
      },
    ]),
    Chunk.aggregate<{ chunks: number; chunkBytes: number | null }>([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          chunks: { $sum: 1 },
          chunkBytes: { $sum: { $bsonSize: '$$ROOT' } },
        },
      },
    ]),
  ]);

  const files = fileRows[0]?.files ?? 0;
  const fileBytes = fileRows[0]?.fileBytes ?? 0;
  const chunks = chunkRows[0]?.chunks ?? 0;
  const chunkBytes = chunkRows[0]?.chunkBytes ?? 0;

  return {
    files,
    fileBytes,
    chunks,
    chunkBytes,
    totalBytes: fileBytes + chunkBytes,
  };
}
