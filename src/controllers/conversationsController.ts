import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { chatAcrossLibrary } from '../services/rag/chat.js';

function serializeSources(
  sources:
    | {
        documentId?: { toString(): string } | string;
        documentName?: string;
        chunkId?: { toString(): string } | string;
        pageNumber?: number;
      }[]
    | undefined,
) {
  if (!sources?.length) return [];
  return sources.map((s) => ({
    documentId: s.documentId?.toString?.() ?? String(s.documentId ?? ''),
    documentName: s.documentName,
    chunkId: s.chunkId?.toString?.() ?? String(s.chunkId ?? ''),
    pageNumber: s.pageNumber,
  }));
}

export const listConversationsHandler = asyncHandler(
  async (req: AuthedRequest, res: Response) => {
    const conversations = await Conversation.find({ userId: req.user!._id }).sort({
      updatedAt: -1,
    });
    res.json({
      conversations: conversations.map((c) => ({
        id: c._id.toString(),
        documentId: c.documentId?.toString() ?? null,
        title: c.title ?? 'Untitled chat',
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    });
  },
);

export const getConversationHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const conversation = await Conversation.findOne({
    _id: req.params.id,
    userId: req.user!._id,
  });
  if (!conversation) throw new AppError('Conversation not found', 404);

  const messages = await Message.find({ conversationId: conversation._id }).sort({
    createdAt: 1,
  });

  res.json({
    conversation: {
      id: conversation._id.toString(),
      documentId: conversation.documentId?.toString() ?? null,
      title: conversation.title ?? 'Untitled chat',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages: messages.map((m) => ({
      id: m._id.toString(),
      role: m.role,
      content: m.content,
      sources: serializeSources(m.sources as never),
      createdAt: m.createdAt,
    })),
  });
});

const chatSchema = z.object({
  question: z.string().min(1).max(4000),
  conversationId: z.string().optional(),
  /** Optional: scope retrieval to one document. Omit to search all ready docs. */
  documentId: z.string().optional(),
});

export const chatHandler = asyncHandler(async (req: AuthedRequest, res: Response) => {
  const body = chatSchema.parse(req.body);
  const result = await chatAcrossLibrary({
    userId: req.user!._id.toString(),
    question: body.question,
    conversationId: body.conversationId,
    documentId: body.documentId,
  });
  res.json(result);
});

export const deleteConversationHandler = asyncHandler(
  async (req: AuthedRequest, res: Response) => {
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      userId: req.user!._id,
    });
    if (!conversation) throw new AppError('Conversation not found', 404);

    await Message.deleteMany({ conversationId: conversation._id });
    await conversation.deleteOne();
    res.json({ ok: true });
  },
);
