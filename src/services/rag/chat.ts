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
  chunkId: string;
  pageNumber?: number;
};

type RetrievedChunk = {
  _id: mongoose.Types.ObjectId;
  content: string;
  pageNumber?: number;
  score?: number;
};

async function loadChunksFallback(
  userId: string,
  documentId: string,
  limit = 6,
): Promise<RetrievedChunk[]> {
  const fallback = await Chunk.find({
    userId: new mongoose.Types.ObjectId(userId),
    documentId: new mongoose.Types.ObjectId(documentId),
  })
    .sort({ chunkIndex: 1 })
    .limit(limit)
    .select('content pageNumber');

  return fallback.map((c) => ({
    _id: c._id,
    content: c.content,
    pageNumber: c.pageNumber ?? undefined,
  }));
}

async function vectorSearch(
  userId: string,
  documentId: string,
  queryEmbedding: number[],
  limit = 6,
): Promise<RetrievedChunk[]> {
  try {
    const results = await Chunk.aggregate<RetrievedChunk>([
      {
        $vectorSearch: {
          index: env.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: Math.max(100, limit * 20),
          limit,
          filter: {
            $and: [
              { userId: { $eq: new mongoose.Types.ObjectId(userId) } },
              { documentId: { $eq: new mongoose.Types.ObjectId(documentId) } },
            ],
          },
        },
      },
      {
        $project: {
          content: 1,
          pageNumber: 1,
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

  return loadChunksFallback(userId, documentId, limit);
}

function buildSystemPrompt(): string {
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
      const page = chunk.pageNumber ? ` (page ${chunk.pageNumber})` : '';
      return `[${i + 1}]${page}\n${chunk.content}`;
    })
    .join('\n\n');
}

export async function chatWithDocument(params: {
  userId: string;
  documentId: string;
  question: string;
  conversationId?: string;
}): Promise<{
  answer: string;
  sources: SourceRef[];
  conversationId: string;
}> {
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

  const chunkCount = await Chunk.countDocuments({
    userId: params.userId,
    documentId: params.documentId,
  });
  if (chunkCount === 0) {
    throw new AppError(
      'This document has no indexed content. Retry processing from Files, or re-upload the PDF.',
      400,
    );
  }

  const user = await User.findById(params.userId);
  if (!user?.openaiApiKeyEncrypted) {
    throw new AppError('Add your OpenAI API key in Settings first', 400);
  }
  const apiKey = decryptSecret(user.openaiApiKeyEncrypted);

  let conversation = params.conversationId
    ? await Conversation.findOne({
        _id: params.conversationId,
        userId: params.userId,
      })
    : null;

  if (!conversation) {
    conversation = await Conversation.create({
      userId: params.userId,
      documentId: params.documentId,
      title: params.question.slice(0, 80),
    });
  }

  const history = await Message.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(20);

  const queryEmbedding = await createEmbedding(apiKey, params.question);
  const retrieved = await vectorSearch(params.userId, params.documentId, queryEmbedding);

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
    system: buildSystemPrompt(),
    messages: [
      ...recentHistory,
      {
        role: 'user',
        content: `Document context:\n${context}\n\nQuestion: ${params.question}`,
      },
    ],
  });

  const sources: SourceRef[] = retrieved.map((chunk) => ({
    documentId: params.documentId,
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
