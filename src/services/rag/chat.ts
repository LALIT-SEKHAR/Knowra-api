import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { Chunk } from '../../models/Chunk.js';
import { Conversation } from '../../models/Conversation.js';
import { Message } from '../../models/Message.js';
import { DocumentModel } from '../../models/Document.js';
import { User } from '../../models/User.js';
import { decryptSecret } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import { createEmbedding, generateChatAnswer } from '../openai/client.js';

export type SourceRef = {
  documentId: string;
  documentName?: string;
  chunkId: string;
  pageNumber?: number;
};

type RetrievedChunk = {
  _id: mongoose.Types.ObjectId;
  documentId: mongoose.Types.ObjectId;
  content: string;
  pageNumber?: number;
  score?: number;
  documentName?: string;
};

async function getReadyDocumentIds(userId: string): Promise<mongoose.Types.ObjectId[]> {
  const docs = await DocumentModel.find({
    userId: new mongoose.Types.ObjectId(userId),
    status: 'ready',
  }).select('_id');
  return docs.map((d) => d._id);
}

async function loadChunksFallback(
  userId: string,
  documentIds: mongoose.Types.ObjectId[],
  limit = 8,
): Promise<RetrievedChunk[]> {
  if (documentIds.length === 0) return [];

  const fallback = await Chunk.find({
    userId: new mongoose.Types.ObjectId(userId),
    documentId: { $in: documentIds },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('content pageNumber documentId');

  return fallback.map((c) => ({
    _id: c._id,
    documentId: c.documentId as mongoose.Types.ObjectId,
    content: c.content,
    pageNumber: c.pageNumber ?? undefined,
  }));
}

async function vectorSearch(
  userId: string,
  documentIds: mongoose.Types.ObjectId[] | null,
  queryEmbedding: number[],
  limit = 8,
): Promise<RetrievedChunk[]> {
  const filter: Record<string, unknown> = {
    userId: { $eq: new mongoose.Types.ObjectId(userId) },
  };
  if (documentIds) {
    if (documentIds.length === 1) {
      filter.documentId = { $eq: documentIds[0] };
    } else if (documentIds.length > 1) {
      filter.documentId = { $in: documentIds };
    } else {
      return [];
    }
  }

  try {
    const results = await Chunk.aggregate<RetrievedChunk>([
      {
        $vectorSearch: {
          index: env.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: Math.max(120, limit * 25),
          limit,
          filter,
        },
      },
      {
        $project: {
          content: 1,
          pageNumber: 1,
          documentId: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    if (results.length > 0) {
      return results;
    }

    console.warn(
      'Vector search returned no results; using chunk fallback (is Atlas Vector Search index ready?)',
    );
  } catch (err) {
    console.warn('Vector search unavailable, falling back to stored chunks', err);
  }

  return loadChunksFallback(userId, documentIds ?? (await getReadyDocumentIds(userId)), limit);
}

async function attachDocumentNames(chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const ids = [...new Set(chunks.map((c) => c.documentId.toString()))];
  if (ids.length === 0) return chunks;

  const docs = await DocumentModel.find({ _id: { $in: ids } }).select('name');
  const nameById = new Map(docs.map((d) => [d._id.toString(), d.name]));

  return chunks.map((chunk) => ({
    ...chunk,
    documentName: nameById.get(chunk.documentId.toString()) ?? 'Document',
  }));
}

function buildSystemPrompt(scope: 'library' | 'document'): string {
  if (scope === 'library') {
    return [
      'You are Knowra, an AI assistant that helps users explore their uploaded documents.',
      'Answer using ONLY the provided document context from the user library.',
      'When context comes from multiple documents, mention which document supports each claim when helpful.',
      'If the context is insufficient, say you cannot find that information in the uploaded documents.',
      'Do not invent page numbers, document names, or facts.',
      'Be clear and concise.',
    ].join(' ');
  }

  return [
    'You are Knowra, an AI assistant that helps users explore documents.',
    'Answer using ONLY the provided document context.',
    'If the context is insufficient, say you cannot find that information in the document.',
    'Do not invent page numbers or facts.',
    'Be clear and concise.',
  ].join(' ');
}

function buildContextBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, i) => {
      const doc = chunk.documentName ? ` · ${chunk.documentName}` : '';
      const page = chunk.pageNumber ? ` · page ${chunk.pageNumber}` : '';
      return `[${i + 1}]${doc}${page}\n${chunk.content}`;
    })
    .join('\n\n');
}

async function requireApiKey(userId: string): Promise<string> {
  const user = await User.findById(userId);
  if (!user?.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings first', 400);
  }
  return decryptSecret(user.openaiApiKeyEncrypted);
}

async function runChat(params: {
  userId: string;
  question: string;
  conversationId?: string;
  documentId?: string;
}): Promise<{
  answer: string;
  sources: SourceRef[];
  conversationId: string;
}> {
  const apiKey = await requireApiKey(params.userId);

  let documentIds: mongoose.Types.ObjectId[] | null = null;
  let scope: 'library' | 'document' = 'library';

  if (params.documentId) {
    const document = await DocumentModel.findOne({
      _id: params.documentId,
      userId: params.userId,
    });
    if (!document) {
      throw new AppError('Document not found', 404);
    }
    if (document.status !== 'ready') {
      throw new AppError('Document is not ready for chat', 400);
    }
    documentIds = [document._id];
    scope = 'document';
  } else {
    const readyIds = await getReadyDocumentIds(params.userId);
    if (readyIds.length === 0) {
      throw new AppError('Upload and process at least one PDF before chatting.', 400);
    }
    // Library mode: search all of this user's chunks (userId filter only)
    documentIds = null;
  }

  const chunkFilter = documentIds
    ? { userId: params.userId, documentId: documentIds[0] }
    : { userId: params.userId };

  const chunkCount = await Chunk.countDocuments(chunkFilter);
  if (chunkCount === 0) {
    throw new AppError(
      'No indexed document content yet. Wait for processing to finish, or retry from Files.',
      400,
    );
  }

  let conversation = params.conversationId
    ? await Conversation.findOne({
        _id: params.conversationId,
        userId: params.userId,
      })
    : null;

  if (!conversation) {
    conversation = await Conversation.create({
      userId: params.userId,
      documentId: params.documentId || undefined,
      title: params.question.slice(0, 80),
    });
  }

  const history = await Message.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(20);

  const queryEmbedding = await createEmbedding(apiKey, params.question);
  const retrievedRaw = await vectorSearch(
    params.userId,
    scope === 'library' ? null : documentIds,
    queryEmbedding,
  );
  const retrieved = await attachDocumentNames(retrievedRaw);

  if (retrieved.length === 0) {
    throw new AppError(
      'No document content available for retrieval. Retry processing from Files.',
      400,
    );
  }

  const context = buildContextBlock(retrieved);
  const recentHistory = history.slice(-8).map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  const answer = await generateChatAnswer(apiKey, {
    system: buildSystemPrompt(scope),
    messages: [
      ...recentHistory,
      {
        role: 'user',
        content: `Document context:\n${context}\n\nQuestion: ${params.question}`,
      },
    ],
  });

  const sources: SourceRef[] = retrieved.map((chunk) => ({
    documentId: chunk.documentId.toString(),
    documentName: chunk.documentName,
    chunkId: chunk._id.toString(),
    pageNumber: chunk.pageNumber,
  }));

  await Message.create({
    conversationId: conversation._id,
    role: 'user',
    content: params.question,
  });
  await Message.create({
    conversationId: conversation._id,
    role: 'assistant',
    content: answer,
    sources,
  });

  conversation.updatedAt = new Date();
  if (!conversation.title) {
    conversation.title = params.question.slice(0, 80);
  }
  await conversation.save();

  return {
    answer,
    sources,
    conversationId: conversation._id.toString(),
  };
}

/** @deprecated Prefer chatAcrossLibrary; kept for document-scoped chats */
export async function chatWithDocument(params: {
  userId: string;
  documentId: string;
  question: string;
  conversationId?: string;
}) {
  return runChat(params);
}

export async function chatAcrossLibrary(params: {
  userId: string;
  question: string;
  conversationId?: string;
  documentId?: string;
}) {
  return runChat(params);
}
