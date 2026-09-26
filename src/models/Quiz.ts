import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const questionSchema = new Schema(
  {
    prompt: { type: String, required: true },
    choices: { type: [String], required: true },
    correctIndex: { type: Number, required: true },
    topic: { type: String, required: true },
    explanation: { type: String, required: true },
    documentName: { type: String },
    pageNumber: { type: Number },
  },
  { _id: false },
);

const resultSchema = new Schema(
  {
    correct: { type: Boolean, required: true },
    correctIndex: { type: Number, required: true },
    topic: { type: String, required: true },
    explanation: { type: String, required: true },
  },
  { _id: false },
);

const attemptSchema = new Schema(
  {
    answers: { type: [Number], required: true },
    correctCount: { type: Number, required: true },
    results: { type: [resultSchema], required: true },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const quizSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    title: { type: String, required: true, trim: true },
    questions: { type: [questionSchema], required: true },
    attempts: { type: [attemptSchema], default: [] },
  },
  { timestamps: true },
);

export type QuizDocument = InferSchemaType<typeof quizSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const Quiz: Model<QuizDocument> =
  mongoose.models.Quiz || mongoose.model<QuizDocument>('Quiz', quizSchema);
