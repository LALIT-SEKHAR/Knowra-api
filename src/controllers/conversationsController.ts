import { z } from 'zod';
import type { Response } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { Conversation } from '../models/Conversation.js';
import { Message } from '../models/Message.js';
import { chatAcrossLibrary } from '../services/rag/chat.js';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function plainText(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[*_~#]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(content: string, query: string) {
  const compact = plainText(content);
  const index = compact.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return compact.slice(0, 90);
  let start = Math.max(0, index - 16);
  let end = Math.min(compact.length, index + query.length + 48);
  if (start > 0) {
    const nextSpace = compact.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < index) start = nextSpace + 1;
  }
  if (end < compact.length) {
    const prevSpace = compact.lastIndexOf(' ', end);
    if (prevSpace > index) end = prevSpace;
  }
  const slice = compact.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${slice}${end < compact.length ? '…' : ''}`;
}

function serializeConversation(
  conversation: {
    _id: { toString(): string };
    documentId?: { toString(): string } | null;
    title?: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  snippet?: string,
) {
  return {
    id: conversation._id.toString(),
    documentId: conversation.documentId?.toString() ?? null,
    title: conversation.title ?? 'Untitled chat',
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(snippet ? { snippet } : {}),
  };
}

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
    const userId = req.user!._id;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';

    if (!q) {
      const conversations = await Conversation.find({ userId }).sort({ updatedAt: -1 });
      res.json({
        conversations: conversations.map((c) => serializeConversation(c)),
      });
      return;
    }

    const matcher = new RegExp(escapeRegex(q), 'i');
    const owned = await Conversation.find({ userId }).select('_id title');
    const ownedIds = owned.map((c) => c._id);
    const messageHits =
      ownedIds.length === 0
        ? []
        : await Message.aggregate<{ _id: (typeof ownedIds)[number]; content: string }>([
            { $match: { conversationId: { $in: ownedIds }, content: matcher } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$conversationId', content: { $first: '$content' } } },
          ]);
    const snippets = new Map(messageHits.map((hit) => [hit._id.toString(), excerpt(hit.content, q)]));
    const titleMatchIds = new Set(
      owned
        .filter((c) => matcher.test(c.title || 'Untitled chat'))
        .map((c) => c._id.toString()),
    );
    const matchIds = new Set([...titleMatchIds, ...snippets.keys()]);
    const conversations = await Conversation.find({
      userId,
      _id: { $in: ownedIds.filter((id) => matchIds.has(id.toString())) },
    }).sort({ updatedAt: -1 });

    res.json({
      conversations: conversations.map((c) => {
        const id = c._id.toString();
        const snippet = titleMatchIds.has(id) ? undefined : snippets.get(id);
        return serializeConversation(c, snippet);
      }),
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
    conversation: serializeConversation(conversation),
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
