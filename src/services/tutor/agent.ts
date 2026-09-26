import mongoose from 'mongoose';
import { XAI_BASE_URL, type ChatProviderId } from '../../config/chatProviders.js';
import { AppError } from '../../utils/errors.js';
import { createOpenAIClient, withRateLimitRetry } from '../openai/client.js';
import type { Workspace } from '../orgs/workspace.js';
import {
  createQuiz,
  listFocus,
  listReadyFiles,
  parseQuizInput,
  readPassage,
} from './quizStore.js';

const MAX_TOOL_CALLS = 6;

export type TutorSource = {
  documentId: string;
  documentName?: string;
  chunkId: string;
  pageNumber?: number;
};

export type TutorSearchHit = {
  chunkId: string;
  documentId: string;
  documentName: string;
  pageNumber?: number;
  excerpt: string;
};

type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List the ready books and course files in this workspace.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_library',
      description: 'Search the uploaded books and courses for a topic. Use a short query.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look up in the files.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_passage',
      description: 'Read one passage returned by search_library.',
      parameters: {
        type: 'object',
        properties: {
          chunkId: { type: 'string', description: 'The chunkId from a search result.' },
        },
        required: ['chunkId'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'learner_focus',
      description: 'Topics this child missed on earlier quizzes. Check this before writing a new quiz.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_quiz',
      description:
        'Save a multiple-choice quiz the child answers in the app. Use only when they asked for questions or a quiz. Do not reveal the correct answers in your reply.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                prompt: { type: 'string' },
                choices: { type: 'array', items: { type: 'string' } },
                correctIndex: { type: 'number' },
                topic: { type: 'string' },
                explanation: { type: 'string' },
                pageNumber: { type: 'number' },
                documentName: { type: 'string' },
              },
              required: ['prompt', 'choices', 'correctIndex', 'topic', 'explanation'],
            },
          },
        },
        required: ['title', 'questions'],
        additionalProperties: false,
      },
    },
  },
];

function tutorSystemPrompt(dateLine: string, scope: 'library' | 'document'): string {
  return [
    'You are Knowra, a tutor helping a child study uploaded books and course files.',
    dateLine,
    'When the child says today, this month, or next month, use that date. Do not pick a month from the files.',
    scope === 'document'
      ? 'They have one file open. Search only that file.'
      : 'They are asking about the whole library.',
    'Use the tools before you explain a topic, make a game, or write questions. Do not invent page numbers, file names, or facts the tools did not return.',
    'You may use a few tools, then answer.',
    'To simplify a topic or turn it into a game, search, read a passage when the excerpt is thin, then explain in short concrete language. A game has a few rounds and a clear goal, and it stays about the real topic.',
    'When they ask for questions, a quiz, or MCQs, call learner_focus, search the course, then create_quiz. Prefer topics they have missed when the files cover them.',
    'Each quiz question needs exactly 4 choices and one correctIndex. The explanation is one or two sentences from the passage.',
    'After create_quiz, say the quiz is ready under your message and name the topics. Do not list the questions or the correct answers.',
    'Do not offer to delete, rewrite, or replace their files.',
    'If the files do not contain the topic, say so.',
  ].join('\n');
}

function toolCallsOf(message: {
  tool_calls?: Array<{
    id: string;
    function?: { name?: string; arguments?: string };
  }>;
}): ToolCall[] {
  return (message.tool_calls ?? []).flatMap((call) => {
    const name = call.function?.name;
    if (!name) return [];
    return [{ id: call.id, name, arguments: call.function?.arguments || '{}' }];
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runTutorAgent(params: {
  provider: ChatProviderId;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  question: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  dateLine: string;
  scope: 'library' | 'document';
  userId: string;
  workspace: Workspace;
  conversationId: string;
  documentIds: mongoose.Types.ObjectId[] | null;
  search: (query: string) => Promise<{ hits: TutorSearchHit[]; embeddingTokens: number }>;
}): Promise<{
  content: string;
  sources: TutorSource[];
  steps: string[];
  quizId?: string;
  usage: { chatTokens: number; embeddings: number; embeddingTokens: number; aiCalls: number };
}> {
  const baseURL =
    params.provider === 'xai'
      ? XAI_BASE_URL
      : params.provider === 'custom'
        ? params.baseUrl?.trim() || undefined
        : undefined;
  const client = createOpenAIClient(params.apiKey, baseURL);
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: tutorSystemPrompt(params.dateLine, params.scope) },
    ...params.history.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: params.question },
  ];
  const steps: string[] = [];
  const sources: TutorSource[] = [];
  const seenChunks = new Set<string>();
  let quizId: string | undefined;
  let toolCalls = 0;
  let chatTokens = 0;
  let embeddings = 0;
  let embeddingTokens = 0;
  let aiCalls = 0;

  function remember(hit: TutorSearchHit) {
    if (seenChunks.has(hit.chunkId)) return;
    seenChunks.add(hit.chunkId);
    sources.push({
      documentId: hit.documentId,
      documentName: hit.documentName,
      chunkId: hit.chunkId,
      pageNumber: hit.pageNumber,
    });
  }

  async function runTool(call: ToolCall): Promise<string> {
    const args = parseArgs(call.arguments);
    if (call.name === 'list_files') {
      const files = await listReadyFiles(params.userId, params.workspace, params.documentIds);
      steps.push(files.length === 1 ? 'Looked at 1 file' : `Looked at ${files.length} files`);
      return JSON.stringify({ files });
    }
    if (call.name === 'search_library') {
      const query = typeof args.query === 'string' ? args.query.trim().slice(0, 300) : '';
      if (!query) return JSON.stringify({ error: 'Pass a query.' });
      const found = await params.search(query);
      embeddings += 1;
      embeddingTokens += found.embeddingTokens;
      found.hits.forEach(remember);
      steps.push(`Searched for ${query}`);
      return JSON.stringify({
        passages: found.hits.map((hit) => ({
          chunkId: hit.chunkId,
          documentName: hit.documentName,
          pageNumber: hit.pageNumber ?? null,
          excerpt: hit.excerpt,
        })),
      });
    }
    if (call.name === 'read_passage') {
      const chunkId = typeof args.chunkId === 'string' ? args.chunkId : '';
      const passage = await readPassage(params.userId, params.workspace, chunkId);
      if (!passage) return JSON.stringify({ error: 'That passage is not in this workspace.' });
      remember({
        chunkId: passage.chunkId,
        documentId: passage.documentId,
        documentName: passage.documentName,
        pageNumber: passage.pageNumber,
        excerpt: passage.content,
      });
      steps.push(
        passage.pageNumber
          ? `Read page ${passage.pageNumber} of ${passage.documentName}`
          : `Read a passage from ${passage.documentName}`,
      );
      return JSON.stringify(passage);
    }
    if (call.name === 'learner_focus') {
      const focus = await listFocus(params.userId, params.workspace);
      steps.push(focus.length ? 'Checked topics to practice' : 'No weak topics yet');
      return JSON.stringify({ focus });
    }
    if (call.name === 'create_quiz') {
      const parsed = parseQuizInput(args);
      if (!parsed.ok) return JSON.stringify({ error: parsed.error });
      const saved = await createQuiz({
        userId: params.userId,
        workspace: params.workspace,
        conversationId: params.conversationId,
        title: parsed.value.title,
        questions: parsed.value.questions,
      });
      quizId = saved.quizId;
      steps.push(`Saved a quiz: ${saved.title}`);
      return JSON.stringify(saved);
    }
    return JSON.stringify({ error: `Unknown tool ${call.name}` });
  }

  try {
    let content = '';
    for (let round = 0; round < MAX_TOOL_CALLS + 1; round += 1) {
      const allowTools = toolCalls < MAX_TOOL_CALLS;
      const response = await withRateLimitRetry(() =>
        client.chat.completions.create({
          model: params.model,
          temperature: 0.4,
          messages: messages as never,
          tools: TOOLS as never,
          tool_choice: allowTools ? ('auto' as const) : ('none' as const),
        }),
      );
      aiCalls += 1;
      const usage = response.usage;
      chatTokens += usage?.total_tokens ?? (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);
      const message = response.choices[0]?.message;
      if (!message) break;
      const calls = allowTools ? toolCallsOf(message) : [];
      if (calls.length === 0) {
        content = message.content?.trim() ?? '';
        break;
      }
      messages.push(message as unknown as Record<string, unknown>);
      for (const call of calls) {
        if (toolCalls >= MAX_TOOL_CALLS) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'Tool limit reached. Answer with what you have.' }),
          });
          continue;
        }
        toolCalls += 1;
        const result = await runTool(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    if (!content) {
      throw new AppError('The tutor did not return an answer. Try asking again.', 502);
    }

    return {
      content,
      sources,
      steps,
      quizId,
      usage: { chatTokens, embeddings, embeddingTokens, aiCalls },
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : '';
    const lower = message.toLowerCase();
    if (
      lower.includes('incorrect api key') ||
      lower.includes('invalid api key') ||
      lower.includes('401') ||
      lower.includes('authentication') ||
      lower.includes('unauthorized')
    ) {
      throw new AppError('The chat API key was rejected. Open Settings → AI and save a valid key.', 400);
    }
    throw new AppError(message.trim().slice(0, 240) || 'The tutor could not answer.', 502);
  }
}
