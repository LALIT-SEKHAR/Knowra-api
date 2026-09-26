import type { Connection } from 'mongoose';
import { env, EMBEDDING_DIMENSIONS } from '../../config/env.js';
import {
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_VECTOR_INDEX_NAME,
} from '../../config/documentProviders.js';

type SearchIndexInfo = {
  name?: string;
  latestDefinition?: { fields?: Array<{ type?: string; path?: string; numDimensions?: number }> };
  definition?: { fields?: Array<{ type?: string; path?: string; numDimensions?: number }> };
};

function indexDefinition(dimensions: number) {
  return {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: dimensions,
        similarity: 'cosine',
      },
      { type: 'filter', path: 'userId' },
      { type: 'filter', path: 'documentId' },
      { type: 'filter', path: 'embeddingProvider' },
    ],
  };
}

function hasProviderFilter(index: SearchIndexInfo): boolean {
  const fields = index.latestDefinition?.fields ?? index.definition?.fields ?? [];
  return fields.some((field) => field.type === 'filter' && field.path === 'embeddingProvider');
}

/**
 * Ensure Atlas Vector Search indexes exist on `chunks`.
 * OpenAI and Custom share the 1536-d index. Gemini uses its own length.
 * Safe to call on every boot — no-ops if already present.
 */
export async function ensureChunkVectorIndex(connection: Connection): Promise<void> {
  const db = connection.db;
  if (!db) {
    console.warn('No MongoDB database handle; skipping vector index setup');
    return;
  }

  const collection = db.collection('chunks');
  let existing: SearchIndexInfo[] = [];
  try {
    existing = (await collection.listSearchIndexes().toArray()) as SearchIndexInfo[];
  } catch (err) {
    console.warn('Could not list search indexes (vector search may be unavailable)', err);
    return;
  }

  await ensureOne(collection, existing, env.VECTOR_INDEX_NAME, EMBEDDING_DIMENSIONS);
  await ensureOne(collection, existing, GEMINI_VECTOR_INDEX_NAME, GEMINI_EMBEDDING_DIMENSIONS);
}

async function ensureOne(
  collection: ReturnType<NonNullable<Connection['db']>['collection']>,
  existing: SearchIndexInfo[],
  name: string,
  dimensions: number,
): Promise<void> {
  const found = existing.find((index) => index.name === name);
  const definition = indexDefinition(dimensions);

  if (found) {
    if (!hasProviderFilter(found)) {
      try {
        await collection.updateSearchIndex(name, definition);
        console.log(`Updated vector search index "${name}" to filter by embedding provider`);
      } catch (err) {
        console.warn(`Could not update vector search index "${name}"`, err);
      }
    } else {
      console.log(`Vector search index "${name}" already exists`);
    }
    return;
  }

  try {
    await collection.createSearchIndex({
      name,
      type: 'vectorSearch',
      definition,
    });
    console.log(
      `Created vector search index "${name}" (${dimensions} dimensions; may take a few minutes to become queryable)`,
    );
  } catch (err) {
    console.warn(
      `Failed to create vector search index "${name}". Chat will use chunk fallback until you create it in Atlas.`,
      err,
    );
  }
}
