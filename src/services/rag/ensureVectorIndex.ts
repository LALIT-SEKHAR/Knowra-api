import type { Connection } from 'mongoose';
import { env, EMBEDDING_DIMENSIONS } from '../../config/env.js';

/**
 * Ensure Atlas Vector Search index exists on `chunks`.
 * Safe to call on every boot — no-ops if already present.
 */
export async function ensureChunkVectorIndex(connection: Connection): Promise<void> {
  const db = connection.db;
  if (!db) {
    console.warn('No MongoDB database handle; skipping vector index setup');
    return;
  }

  const collection = db.collection('chunks');

  try {
    const existing = await collection.listSearchIndexes().toArray();
    const found = existing.some((idx: { name?: string }) => idx.name === env.VECTOR_INDEX_NAME);
    if (found) {
      console.log(`Vector search index "${env.VECTOR_INDEX_NAME}" already exists`);
      return;
    }
  } catch (err) {
    console.warn('Could not list search indexes (vector search may be unavailable)', err);
    return;
  }

  try {
    await collection.createSearchIndex({
      name: env.VECTOR_INDEX_NAME,
      type: 'vectorSearch',
      definition: {
        fields: [
          {
            type: 'vector',
            path: 'embedding',
            numDimensions: EMBEDDING_DIMENSIONS,
            similarity: 'cosine',
          },
          { type: 'filter', path: 'userId' },
          { type: 'filter', path: 'documentId' },
        ],
      },
    });
    console.log(
      `Created vector search index "${env.VECTOR_INDEX_NAME}" (may take a few minutes to become queryable)`,
    );
  } catch (err) {
    console.warn(
      `Failed to create vector search index "${env.VECTOR_INDEX_NAME}". Chat will use chunk fallback until you create it in Atlas.`,
      err,
    );
  }
}
