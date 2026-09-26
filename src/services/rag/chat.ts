import mongoose from 'mongoose';
import { env } from '../../config/env.js';
import { Chunk } from '../../models/Chunk.js';
import { Conversation, type ConversationDocument } from '../../models/Conversation.js';
import { Message } from '../../models/Message.js';
import { DocumentModel } from '../../models/Document.js';
import { User } from '../../models/User.js';
import type { OrganizationDocument } from '../../models/Organization.js';
import { decryptSecret } from '../../utils/crypto.js';
import { AppError } from '../../utils/errors.js';
import {
  libraryFilter,
  type Workspace,
} from '../orgs/workspace.js';
import {
  resolveChatSelection,
  type ChatProviderId,
} from '../../config/chatProviders.js';
import { generateChatAnswer } from '../chat/generate.js';
import { canonicalizeMarkdownMath } from '../chat/markdownMath.js';
import { runTutorAgent } from '../tutor/agent.js';
import { createEmbedding } from '../openai/client.js';
import { recordUsage } from '../usage/record.js';

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
  orgId?: mongoose.Types.ObjectId | null;
  score?: number;
  documentName?: string;
};

async function getReadyDocumentIds(
  userId: string,
  workspace: Workspace,
): Promise<mongoose.Types.ObjectId[]> {
  const docs = await DocumentModel.find({
    ...libraryFilter(workspace, new mongoose.Types.ObjectId(userId)),
    status: 'ready',
  }).select('_id');
  return docs.map((d) => d._id);
}

async function loadChunksFallback(
  userId: string,
  documentIds: mongoose.Types.ObjectId[],
  workspace: Workspace,
  limit = 8,
): Promise<RetrievedChunk[]> {
  if (documentIds.length === 0) return [];

  const fallback = await Chunk.find({
    ...libraryFilter(workspace, new mongoose.Types.ObjectId(userId)),
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
  workspace: Workspace,
  limit = 8,
): Promise<RetrievedChunk[]> {
  const filter: Record<string, unknown> = {};
  if (workspace.orgId) {
    filter.orgId = { $eq: workspace.orgId };
  } else {
    filter.userId = { $eq: new mongoose.Types.ObjectId(userId) };
  }
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
          orgId: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    if (results.length > 0) {
      const scoped = workspace.orgId
        ? results.filter((chunk) => chunk.orgId?.toString() === workspace.orgId?.toString())
        : results.filter((chunk) => !chunk.orgId);
      if (scoped.length > 0) return scoped;
    }

    console.warn(
      'Vector search returned no results; using chunk fallback (is Atlas Vector Search index ready?)',
    );
  } catch (err) {
    console.warn('Vector search unavailable, falling back to stored chunks', err);
  }

  return loadChunksFallback(userId, documentIds ?? (await getReadyDocumentIds(userId, workspace)), workspace, limit);
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

const CASUAL = [
  'hi',
  'hello',
  'hey',
  'hiya',
  'howdy',
  'yo',
  'sup',
  'good morning',
  'good afternoon',
  'good evening',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'ok',
  'okay',
  'cool',
  'great',
  'nice',
  'bye',
  'goodbye',
  'see you',
  'what can you do',
  'who are you',
  'help',
];

function isCasualMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[!?.]+$/g, '');
  if (!normalized || normalized.length > 80) return false;
  return CASUAL.some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `));
}

function cleanGeneratedTitle(raw: string): string {
  let title = raw.trim().split('\n').find((line) => line.trim()) ?? '';
  title = title.replace(/^title\s*:\s*/i, '').trim();
  title = title.replace(/^["'`“”]+|["'`“”]+$/g, '').trim();
  title = title.replace(/[.!?]+$/g, '').trim();
  if (title.length > 60) title = title.slice(0, 60).trim();
  return title;
}

function conversationForTitle(turns: Array<{ role: string; content: string }>): string {
  return turns
    .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && turn.content.trim())
    .slice(0, 8)
    .map((turn) => {
      const speaker = turn.role === 'user' ? 'User' : 'Assistant';
      return `${speaker}: ${turn.content.trim().slice(0, 300)}`;
    })
    .join('\n\n');
}

/**
 * Writes the sidebar title once, from the first exchange — including a greeting or thanks.
 * Later messages never rename the chat.
 */
async function lockConversationTitleOnce(params: {
  conversation: ConversationDocument;
  priorMessages: Array<{ role: string; content: string }>;
  question: string;
  answer: string;
  access: ChatAccess;
  userId: string;
}): Promise<void> {
  if (params.conversation.titleLocked) return;

  const transcript = conversationForTitle([
    ...params.priorMessages,
    { role: 'user', content: params.question },
    { role: 'assistant', content: params.answer },
  ]);
  if (!transcript) return;

  try {
    const result = await generateChatAnswer({
      provider: params.access.chatProvider,
      model: params.access.chatModel,
      apiKey: params.access.chatApiKey,
      baseUrl: params.access.customBaseUrl,
      temperature: 0.2,
      maxTokens: 24,
      system:
        'Name this chat in 3 to 6 words from what the user and assistant actually said, including greetings and short replies. Reply with the title only. No quotes, no punctuation at the end, no prefix.',
      messages: [
        {
          role: 'user',
          content: transcript,
        },
      ],
    });
    const title = cleanGeneratedTitle(result.content);
    if (title.length < 2) return;
    params.conversation.title = title;
    params.conversation.titleLocked = true;
    await recordUsage(params.userId, {
      chatTokens: result.usage.totalTokens,
      aiCalls: 1,
    });
  } catch (err) {
    console.warn('Conversation title was not updated', err);
  }
}

function calendarHint(now = new Date()): string {
  const date = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  const thisMonth = now.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  const next = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  next.setMonth(next.getMonth() + 1, 1);
  const nextMonth = next.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  return `Today is ${date}. This month is ${thisMonth}. Next month is ${nextMonth}.`;
}

function buildSystemPrompt(scope: 'library' | 'document'): string {
  const shared = [
    'You are Knowra, a friendly AI assistant that helps users explore their uploaded documents.',
    calendarHint(),
    'When the user says today, tomorrow, this month, next month, or another relative time, use that date. Do not pick a month from the documents.',
    'For greetings, thanks, or small talk, reply briefly and warmly. Offer to help with their documents.',
    'For questions about your capabilities, explain that you can search and answer from their uploaded PDFs.',
    'For document questions, use ONLY the provided document context. Do not invent page numbers, document names, or facts.',
    'If a document question cannot be answered from the context, say you cannot find that information in the uploaded documents.',
    'Be clear and concise. Match the length and shape the user asked for — one line when they ask for one line. Use Markdown sparingly: bold for key terms, lists only when there are several distinct points.',
    'Phrase every answer freshly. If the user asks the same thing again, keep the facts correct and change the wording and structure. Do not copy an earlier reply, and do not end with a stock offer to ask more questions.',
    [
      'When an answer includes mathematics, write it as Markdown math. Never wrap a formula in parentheses or square brackets.',
      'Inline symbols use single dollars, for example $x^2$ or $\\lambda = 0^\\circ$. A longer equation sits between $$ markers, each on its own line, with nothing else on the closing line.',
      'Use LaTeX commands for Greek letters, subscripts, and superscripts.',
      'Answers are text only. Do not tell the user that a page image will appear under the reply. When they ask for a diagram or figure, explain it from the notes and name the page. Do not redraw the figure as ASCII art.',
    ].join('\n'),
  ];

  if (scope === 'library') {
    return [
      ...shared,
      'When context comes from multiple documents, mention which document supports each claim when helpful.',
    ].join(' ');
  }

  return shared.join(' ');
}

function buildCasualSystemPrompt(): string {
  return [
    'You are Knowra, a friendly AI assistant for exploring uploaded PDF documents.',
    'Reply briefly and warmly to greetings and small talk. Phrase each reply freshly instead of repeating a previous answer.',
    "If asked what you can do, say you can answer questions using the user's uploaded documents.",
    'Do not invent document contents. Keep replies short. Match the length the user asked for.',
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

type ChatAccess = {
  openaiApiKey: string;
  chatProvider: ChatProviderId;
  chatModel: string;
  chatApiKey: string;
  customBaseUrl?: string | null;
};

type KeySource = {
  openaiApiKeyEncrypted?: string | null;
  chatProvider?: string | null;
  chatModel?: string | null;
  anthropicApiKeyEncrypted?: string | null;
  googleApiKeyEncrypted?: string | null;
  xaiApiKeyEncrypted?: string | null;
  customApiKeyEncrypted?: string | null;
  customBaseUrl?: string | null;
};

async function requireChatAccess(userId: string, workspace: Workspace): Promise<ChatAccess> {
  const source: KeySource | OrganizationDocument | null = workspace.org
    ? workspace.org
    : await User.findById(userId);
  if (!source?.openaiApiKeyEncrypted) {
    throw new AppError(
      workspace.org
        ? 'Your organization admin needs to add an OpenAI API key in Settings → AI'
        : 'Add your OpenAI API key in Settings → AI (needed to search your documents)',
      400,
    );
  }

  const { provider, model } = resolveChatSelection(source.chatProvider, source.chatModel);
  const openaiApiKey = decryptSecret(source.openaiApiKeyEncrypted);

  if (provider === 'openai') {
    return {
      openaiApiKey,
      chatProvider: provider,
      chatModel: model,
      chatApiKey: openaiApiKey,
    };
  }

  if (provider === 'anthropic') {
    if (!source.anthropicApiKeyEncrypted) {
      throw new AppError(
        workspace.org
          ? 'Your organization admin needs to add an Anthropic API key for Claude chat'
          : 'Add your Anthropic API key in Settings → AI for Claude chat',
        400,
      );
    }
    return {
      openaiApiKey,
      chatProvider: provider,
      chatModel: model,
      chatApiKey: decryptSecret(source.anthropicApiKeyEncrypted),
    };
  }

  if (provider === 'google') {
    if (!source.googleApiKeyEncrypted) {
      throw new AppError(
        workspace.org
          ? 'Your organization admin needs to add a Google AI API key for Gemini chat'
          : 'Add your Google AI API key in Settings → AI for Gemini chat',
        400,
      );
    }
    return {
      openaiApiKey,
      chatProvider: provider,
      chatModel: model,
      chatApiKey: decryptSecret(source.googleApiKeyEncrypted),
    };
  }

  if (provider === 'xai') {
    if (!source.xaiApiKeyEncrypted) {
      throw new AppError(
        workspace.org
          ? 'Your organization admin needs to add an xAI API key for Grok chat'
          : 'Add your xAI API key in Settings → AI for Grok chat',
        400,
      );
    }
    return {
      openaiApiKey,
      chatProvider: provider,
      chatModel: model,
      chatApiKey: decryptSecret(source.xaiApiKeyEncrypted),
    };
  }

  if (!source.customBaseUrl?.trim()) {
    throw new AppError(
      workspace.org
        ? 'Your organization admin needs to add a custom API base URL before chatting'
        : 'Add your custom API base URL in Settings → AI before chatting',
      400,
    );
  }

  return {
    openaiApiKey,
    chatProvider: 'custom',
    chatModel: model,
    chatApiKey: source.customApiKeyEncrypted
      ? decryptSecret(source.customApiKeyEncrypted)
      : 'not-needed',
    customBaseUrl: source.customBaseUrl,
  };
}

async function runChat(params: {
  userId: string;
  question: string;
  conversationId?: string;
  documentId?: string;
  mention?: { name: string; at: number };
  workspace: Workspace;
}): Promise<{
  answer: string;
  sources: SourceRef[];
  conversationId: string;
}> {
  const access = await requireChatAccess(params.userId, params.workspace);
  const { openaiApiKey, chatProvider, chatModel, chatApiKey, customBaseUrl } = access;
  const casual = isCasualMessage(params.question);

  let documentIds: mongoose.Types.ObjectId[] | null = null;
  let scope: 'library' | 'document' = 'library';

  if (!casual) {
    if (params.documentId) {
      const document = await DocumentModel.findOne({
        _id: params.documentId,
        ...libraryFilter(params.workspace, new mongoose.Types.ObjectId(params.userId)),
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
      const readyIds = await getReadyDocumentIds(params.userId, params.workspace);
      if (readyIds.length === 0) {
        throw new AppError('Upload and process at least one PDF before chatting.', 400);
      }
      // Library mode: search all of this user's chunks (userId filter only)
      documentIds = null;
    }

    const owner = libraryFilter(params.workspace, new mongoose.Types.ObjectId(params.userId));
    const chunkFilter = documentIds
      ? { ...owner, documentId: documentIds[0] }
      : owner;

    const chunkCount = await Chunk.countDocuments(chunkFilter);
    if (chunkCount === 0) {
      throw new AppError(
        'No indexed document content yet. Wait for processing to finish, or retry from Files.',
        400,
      );
    }
  } else if (params.documentId) {
    documentIds = [new mongoose.Types.ObjectId(params.documentId)];
    scope = 'document';
  }

  let conversation = params.conversationId
    ? await Conversation.findOne({
        _id: params.conversationId,
        userId: params.userId,
        orgId: params.workspace.orgId,
      })
    : null;

  if (!conversation) {
    conversation = await Conversation.create({
      userId: params.userId,
      orgId: params.workspace.orgId,
      documentId: params.documentId || undefined,
      title: params.question.slice(0, 80),
    });
  }

  const history = await Message.find({ conversationId: conversation._id })
    .sort({ createdAt: 1 })
    .limit(20);

  const recentHistory = history.slice(-8).map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  // Greetings / small talk should not force document retrieval.
  if (casual) {
    const answer = await generateChatAnswer({
      provider: chatProvider,
      model: chatModel,
      apiKey: chatApiKey,
      baseUrl: customBaseUrl,
      system: buildCasualSystemPrompt(),
      messages: [...recentHistory, { role: 'user', content: params.question }],
    });
    const content = canonicalizeMarkdownMath(answer.content);

    await Message.create({
      conversationId: conversation._id,
      role: 'user',
      content: params.question,
      mention: params.mention,
    });
    await Message.create({
      conversationId: conversation._id,
      role: 'assistant',
      content,
      sources: [],
    });

    await lockConversationTitleOnce({
      conversation,
      priorMessages: history.map((message) => ({ role: message.role, content: message.content })),
      question: params.question,
      answer: content,
      access,
      userId: params.userId,
    });
    conversation.updatedAt = new Date();
    if (!conversation.title) {
      conversation.title = params.question.slice(0, 80);
    }
    await conversation.save();

    await recordUsage(params.userId, {
      chats: 1,
      chatTokens: answer.usage.totalTokens,
      aiCalls: 1,
    });

    return {
      answer: content,
      sources: [],
      conversationId: conversation._id.toString(),
    };
  }

  const supportsTools =
    chatProvider === 'openai' || chatProvider === 'xai' || chatProvider === 'custom';

  if (supportsTools) {
    const agent = await runTutorAgent({
      provider: chatProvider,
      model: chatModel,
      apiKey: chatApiKey,
      baseUrl: customBaseUrl,
      question: params.question,
      history: recentHistory.flatMap((message) =>
        message.role === 'user' || message.role === 'assistant'
          ? [{ role: message.role, content: message.content }]
          : [],
      ),
      dateLine: calendarHint(),
      scope,
      userId: params.userId,
      workspace: params.workspace,
      conversationId: conversation._id.toString(),
      documentIds,
      search: async (query) => {
        const queryEmbedding = await createEmbedding(
          openaiApiKey,
          `${query}\n${calendarHint()}`,
        );
        const retrievedRaw = await vectorSearch(
          params.userId,
          scope === 'library' ? null : documentIds,
          queryEmbedding.embedding,
          params.workspace,
          6,
        );
        const retrieved = await attachDocumentNames(retrievedRaw);
        return {
          embeddingTokens: queryEmbedding.usage.totalTokens,
          hits: retrieved.map((chunk) => ({
            chunkId: chunk._id.toString(),
            documentId: chunk.documentId.toString(),
            documentName: chunk.documentName ?? 'Document',
            pageNumber: chunk.pageNumber,
            excerpt: chunk.content.slice(0, 700),
          })),
        };
      },
    });
    const content = canonicalizeMarkdownMath(agent.content);
    const sources = agent.sources;

    await Message.create({
      conversationId: conversation._id,
      role: 'user',
      content: params.question,
      mention: params.mention,
    });
    await Message.create({
      conversationId: conversation._id,
      role: 'assistant',
      content,
      sources,
      steps: agent.steps.length ? agent.steps : undefined,
      quizId: agent.quizId,
    });

    await lockConversationTitleOnce({
      conversation,
      priorMessages: history.map((message) => ({ role: message.role, content: message.content })),
      question: params.question,
      answer: content,
      access,
      userId: params.userId,
    });
    conversation.updatedAt = new Date();
    if (!conversation.title) {
      conversation.title = params.question.slice(0, 80);
    }
    await conversation.save();

    await recordUsage(params.userId, {
      chats: 1,
      chatTokens: agent.usage.chatTokens,
      embeddings: agent.usage.embeddings,
      embeddingTokens: agent.usage.embeddingTokens,
      aiCalls: agent.usage.aiCalls,
    });

    return {
      answer: content,
      sources,
      conversationId: conversation._id.toString(),
    };
  }

  const queryEmbedding = await createEmbedding(
    openaiApiKey,
    `${params.question}\n${calendarHint()}`,
  );
  const retrievedRaw = await vectorSearch(
    params.userId,
    scope === 'library' ? null : documentIds,
    queryEmbedding.embedding,
    params.workspace,
  );
  const retrieved = await attachDocumentNames(retrievedRaw);

  if (retrieved.length === 0) {
    throw new AppError(
      'No document content available for retrieval. Retry processing from Files.',
      400,
    );
  }

  const context = buildContextBlock(retrieved);

  const answer = await generateChatAnswer({
    provider: chatProvider,
    model: chatModel,
    apiKey: chatApiKey,
    baseUrl: customBaseUrl,
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
  const content = canonicalizeMarkdownMath(answer.content);

  await Message.create({
    conversationId: conversation._id,
    role: 'user',
    content: params.question,
    mention: params.mention,
  });
  await Message.create({
    conversationId: conversation._id,
    role: 'assistant',
    content,
    sources,
  });

  await lockConversationTitleOnce({
    conversation,
    priorMessages: history.map((message) => ({ role: message.role, content: message.content })),
    question: params.question,
    answer: content,
    access,
    userId: params.userId,
  });
  conversation.updatedAt = new Date();
  if (!conversation.title) {
    conversation.title = params.question.slice(0, 80);
  }
  await conversation.save();

  await recordUsage(params.userId, {
    chats: 1,
    chatTokens: answer.usage.totalTokens,
    embeddings: 1,
    embeddingTokens: queryEmbedding.usage.totalTokens,
    aiCalls: 2,
  });

  return {
    answer: content,
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
  mention?: { name: string; at: number };
  workspace: Workspace;
}) {
  return runChat(params);
}

export async function chatAcrossLibrary(params: {
  userId: string;
  question: string;
  conversationId?: string;
  documentId?: string;
  mention?: { name: string; at: number };
  workspace: Workspace;
}) {
  return runChat(params);
}
