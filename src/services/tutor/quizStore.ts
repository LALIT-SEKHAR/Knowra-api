import mongoose from 'mongoose';
import { z } from 'zod';
import { Chunk } from '../../models/Chunk.js';
import { DocumentModel } from '../../models/Document.js';
import { LearnerFocus } from '../../models/LearnerFocus.js';
import { Quiz, type QuizDocument } from '../../models/Quiz.js';
import { AppError } from '../../utils/errors.js';
import { libraryFilter, type Workspace } from '../orgs/workspace.js';

const quizInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  questions: z
    .array(
      z.object({
        prompt: z.string().trim().min(1).max(400),
        choices: z.array(z.string().trim().min(1).max(200)).length(4),
        correctIndex: z.number().int().min(0),
        topic: z.string().trim().min(1).max(80),
        explanation: z.string().trim().min(1).max(500),
        pageNumber: z.number().int().positive().optional(),
        documentName: z.string().trim().max(200).optional(),
      }),
    )
    .min(3)
    .max(8),
});

export type PublicQuiz = {
  id: string;
  title: string;
  questions: { prompt: string; choices: string[]; topic: string }[];
  attempt: null | {
    answers: number[];
    correctCount: number;
    total: number;
    results: {
      correct: boolean;
      correctIndex: number;
      topic: string;
      explanation: string;
    }[];
    focus: { topic: string; misses: number }[];
  };
};

export type FocusTopic = { topic: string; misses: number };

function owner(workspace: Workspace, userId: string) {
  return libraryFilter(workspace, new mongoose.Types.ObjectId(userId));
}

function topicKey(topic: string): string {
  return topic.trim().toLowerCase().slice(0, 80);
}

export async function listReadyFiles(
  userId: string,
  workspace: Workspace,
  documentIds: mongoose.Types.ObjectId[] | null,
) {
  const filter: Record<string, unknown> = {
    ...owner(workspace, userId),
    status: 'ready',
  };
  if (documentIds?.length) filter._id = { $in: documentIds };
  const docs = await DocumentModel.find(filter).select('name pageCount').sort({ name: 1 }).limit(30);
  return docs.map((doc) => ({
    id: doc._id.toString(),
    name: doc.name,
    pageCount: doc.pageCount ?? null,
  }));
}

export async function readPassage(userId: string, workspace: Workspace, chunkId: string) {
  if (!mongoose.Types.ObjectId.isValid(chunkId)) return null;
  const chunk = await Chunk.findOne({
    _id: chunkId,
    ...owner(workspace, userId),
  }).select('content pageNumber documentId');
  if (!chunk) return null;
  const doc = await DocumentModel.findById(chunk.documentId).select('name');
  return {
    chunkId: chunk._id.toString(),
    documentId: chunk.documentId.toString(),
    documentName: doc?.name ?? 'Document',
    pageNumber: chunk.pageNumber ?? undefined,
    content: chunk.content.slice(0, 1800),
  };
}

export async function listFocus(userId: string, workspace: Workspace): Promise<FocusTopic[]> {
  const rows = await LearnerFocus.find({
    ...owner(workspace, userId),
    misses: { $gt: 0 },
  })
    .sort({ misses: -1, updatedAt: -1 })
    .limit(6)
    .select('topic misses');
  return rows.map((row) => ({ topic: row.topic, misses: row.misses ?? 0 }));
}

export function parseQuizInput(raw: unknown): { ok: true; value: z.infer<typeof quizInputSchema> } | { ok: false; error: string } {
  const parsed = quizInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: 'Quiz needs a title and 3 to 8 questions, each with exactly 4 choices.' };
  }
  for (const question of parsed.data.questions) {
    if (question.correctIndex >= question.choices.length) {
      return { ok: false, error: 'correctIndex must point at one of the choices.' };
    }
  }
  return { ok: true, value: parsed.data };
}

export async function createQuiz(params: {
  userId: string;
  workspace: Workspace;
  conversationId: string;
  title: string;
  questions: z.infer<typeof quizInputSchema>['questions'];
}) {
  const quiz = await Quiz.create({
    userId: params.userId,
    orgId: params.workspace.orgId,
    conversationId: params.conversationId,
    title: params.title,
    questions: params.questions,
    attempts: [],
  });
  return {
    quizId: quiz._id.toString(),
    title: quiz.title,
    questionCount: quiz.questions.length,
    topics: [...new Set(quiz.questions.map((question) => question.topic))],
  };
}

export function toPublicQuiz(quiz: QuizDocument, focus: FocusTopic[]): PublicQuiz {
  const attempt = quiz.attempts?.[0];
  return {
    id: quiz._id.toString(),
    title: quiz.title,
    questions: quiz.questions.map((question) => ({
      prompt: question.prompt,
      choices: question.choices,
      topic: question.topic,
    })),
    attempt: attempt
      ? {
          answers: attempt.answers,
          correctCount: attempt.correctCount,
          total: quiz.questions.length,
          results: attempt.results.map((result) => ({
            correct: result.correct,
            correctIndex: result.correctIndex,
            topic: result.topic,
            explanation: result.explanation,
          })),
          focus,
        }
      : null,
  };
}

export async function quizzesForUser(
  userId: string,
  workspace: Workspace,
  ids: mongoose.Types.ObjectId[],
) {
  if (ids.length === 0) return new Map<string, QuizDocument>();
  const quizzes = await Quiz.find({
    _id: { $in: ids },
    userId,
    orgId: workspace.orgId,
  });
  return new Map(quizzes.map((quiz) => [quiz._id.toString(), quiz]));
}

export async function scoreQuiz(params: {
  quizId: string;
  userId: string;
  workspace: Workspace;
  answers: number[];
}): Promise<PublicQuiz> {
  if (!mongoose.Types.ObjectId.isValid(params.quizId)) {
    throw new AppError('Quiz not found', 404);
  }
  const quiz = await Quiz.findOne({
    _id: params.quizId,
    userId: params.userId,
    orgId: params.workspace.orgId,
  });
  if (!quiz) throw new AppError('Quiz not found', 404);

  const focus = () => listFocus(params.userId, params.workspace);

  if (quiz.attempts?.length) {
    return toPublicQuiz(quiz, await focus());
  }

  if (params.answers.length !== quiz.questions.length) {
    throw new AppError('Answer every question before submitting.', 400);
  }

  const results = quiz.questions.map((question, index) => {
    const chosen = params.answers[index];
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= question.choices.length) {
      throw new AppError('Answer every question before submitting.', 400);
    }
    return {
      correct: chosen === question.correctIndex,
      correctIndex: question.correctIndex,
      topic: question.topic,
      explanation: question.explanation,
    };
  });

  const saved = await Quiz.findOneAndUpdate(
    { _id: quiz._id, attempts: { $size: 0 } },
    {
      $set: {
        attempts: [
          {
            answers: params.answers,
            correctCount: results.filter((result) => result.correct).length,
            results,
            createdAt: new Date(),
          },
        ],
      },
    },
    { new: true },
  );
  if (!saved) {
    const current = await Quiz.findById(quiz._id);
    if (!current) throw new AppError('Quiz not found', 404);
    return toPublicQuiz(current, await focus());
  }

  const userId = new mongoose.Types.ObjectId(params.userId);
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const question = quiz.questions[index]!;
    await LearnerFocus.findOneAndUpdate(
      {
        userId,
        orgId: params.workspace.orgId,
        topicKey: topicKey(question.topic),
      },
      {
        $set: { topic: question.topic, userId, orgId: params.workspace.orgId },
        $inc: result.correct ? { correct: 1 } : { misses: 1 },
      },
      { upsert: true },
    );
  }

  return toPublicQuiz(saved, await focus());
}
