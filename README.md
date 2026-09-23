# Knowra API

Express + TypeScript backend for [Knowra](../Knowra). It authenticates users, stores PDFs, indexes them for search, and answers questions with retrieval-augmented generation (RAG).

The web app never embeds or chats on its own. This server does that work with the user’s API keys.

## What it is responsible for

- Email one-time-code login and JWT sessions
- Encrypted storage of provider API keys
- PDF registration, processing jobs, and deletion
- Chunk embeddings and Atlas Vector Search
- Chat across one document or the user’s whole library
- Usage totals and account purge

## RAG pipeline

File intake, chunking, and embeddings are written up in [RAG.md](./RAG.md). The short version:

Indexing and answering are separate. Indexing runs once per upload. Answering runs on every question.

### Indexing

`process_document` jobs in `src/services/jobs/worker.ts`:

1. Download the PDF from Cloudinary.
2. Extract selectable text with `unpdf` (`src/services/documents/parser.ts`).
3. If a file has no selectable text, render pages and OCR them with `gpt-4o-mini` (`src/services/documents/ocr.ts`). OCR supports up to 40 pages, two pages at a time.
4. Split text into chunks of **1,000** characters with **200** characters of overlap. Each chunk keeps its page number.
5. Embed chunks with OpenAI **`text-embedding-3-small`** (1,536 dimensions), in batches of 64 (`src/services/openai/client.ts`).
6. Replace any previous chunks for that document and mark it `ready`.

Document status is `uploading`, `processing`, `ready`, or `failed`. Chat only uses `ready` documents that have chunks.

### Answering

`src/services/rag/chat.ts`:

1. Require an OpenAI key. Embeddings always use it, even when chat uses another provider.
2. Embed the question with the same model used at index time.
3. Run MongoDB Atlas `$vectorSearch` on the `chunks` collection (cosine similarity). Results are filtered by `userId`, and by `documentId` when a document is selected. The search returns **8** chunks.
4. If the vector index is unavailable or returns nothing, fall back to recently stored chunks.
5. Build a context block labeled with document name and page number.
6. Call the user’s chosen chat model (`src/services/chat/generate.ts`) with a system prompt that limits the answer to that context.
7. Save the user and assistant messages, including source refs, and return the answer.

Greetings and other short small-talk skip retrieval. A conversation keeps recent messages so follow-up questions have history.

Chat providers: OpenAI, Anthropic, Google Gemini, xAI Grok, and a custom OpenAI-compatible base URL. Temperature is `0.2`.

## Project structure

```
src/
  server.ts                     local HTTP server + job worker
  app.ts                        Express app, CORS, DB, vector index
  config/
    env.ts                      environment and RAG constants
    chatProviders.ts            provider and model catalog
    db.ts                       MongoDB connection
  routes/                       HTTP routers
  controllers/                  request handlers
  middleware/auth.ts            Bearer JWT check
  models/                       Mongoose schemas
  services/
    rag/chat.ts                 retrieval + prompt + answer
    rag/ensureVectorIndex.ts    create the Atlas index when possible
    documents/parser.ts         text extract and chunking
    documents/ocr.ts            scanned-PDF OCR
    openai/client.ts            embeddings and vision OCR
    chat/generate.ts            provider-specific chat calls
    jobs/worker.ts              background queue
    cloudinary/storage.ts       PDF upload signatures and downloads
    auth/otp.ts                 email codes
    usage/record.ts             daily usage counters
api/index.ts                    Vercel serverless entry
atlas-vector-index.json         index definition to create in Atlas
```

## Data

MongoDB collections:

| Collection | Holds |
| --- | --- |
| `users` | Email, profile, encrypted provider keys, deletion schedule |
| `documents` | PDF metadata, Cloudinary location, status, progress |
| `chunks` | Passage text, page number, 1,536-d embedding |
| `conversations` | Chat threads, optional document scope |
| `messages` | User and assistant turns, plus sources |
| `jobs` | `process_document`, `delete_document`, `purge_account` |
| `usagedailies` | Per-day counts of uploads, tokens, chats |
| `otps` | Login and deletion codes |

Keys are encrypted with `ENCRYPTION_KEY` before they are written. Responses expose only the last four characters.

Every retrieval filter includes `userId`, so one account cannot read another account’s chunks.

## HTTP API

Base path: `/api`. Authenticated routes expect `Authorization: Bearer <jwt>`. Tokens last 7 days.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness |
| `POST` | `/auth/request-otp` | Email a login code |
| `POST` | `/auth/verify-otp` | Exchange the code for a JWT |
| `GET` | `/auth/me` | Current user |
| `PATCH` | `/auth/me` | Update name |
| `POST` | `/auth/me/avatar` | Upload avatar |
| `DELETE` | `/auth/me/avatar` | Remove avatar |
| `POST` | `/auth/logout` | End the session |
| `GET` | `/settings` | Keys, chat provider, models |
| `PUT` | `/settings/openai-key` | Save OpenAI key |
| `DELETE` | `/settings/openai-key` | Remove OpenAI key |
| `PUT` | `/settings/chat-prefs` | Provider, model, custom base URL |
| `PUT` | `/settings/provider-key` | Save Claude, Gemini, Grok, or custom key |
| `DELETE` | `/settings/provider-key/:provider` | Remove a provider key |
| `DELETE` | `/settings/chats` | Delete all conversations |
| `POST` | `/settings/files/request-otp` | Code to delete every file |
| `DELETE` | `/settings/files` | Delete every file after the code |
| `POST` | `/settings/account/request-otp` | Code to schedule account deletion |
| `DELETE` | `/settings/account` | Schedule purge (7-day grace) |
| `POST` | `/settings/account/cancel` | Cancel a scheduled purge |
| `GET` | `/documents` | List PDFs (`?q=` filters by name) |
| `GET` | `/documents/upload-signature` | Cloudinary signature for a direct upload |
| `POST` | `/documents` | Register an uploaded PDF and enqueue processing |
| `GET` | `/documents/:id` | One PDF |
| `GET` | `/documents/:id/file` | Download the stored PDF |
| `PATCH` | `/documents/:id` | Rename |
| `DELETE` | `/documents/:id` | Queue deletion of file, chunks, and related chats |
| `POST` | `/documents/:id/retry` | Re-queue a failed document |
| `POST` | `/documents/:id/chat` | Chat scoped to one document |
| `POST` | `/conversations/chat` | Library-wide chat, or scoped when `documentId` is set |
| `GET` | `/conversations` | List threads |
| `GET` | `/conversations/:id` | Thread and messages |
| `DELETE` | `/conversations/:id` | Delete one thread |
| `GET` | `/usage` | Upload, embedding, OCR, and chat totals |
| `GET` | `/cron/jobs` | Drain pending jobs (optional `CRON_SECRET`) |

The preferred upload path avoids sending the PDF through this server:

1. `GET /documents/upload-signature`
2. Browser `POST`s the file to Cloudinary
3. `POST /documents` with the Cloudinary `public_id` and URL

`POST /documents` also accepts a multipart file for local use. Max size defaults to 20 MB. Only PDFs are accepted. An OpenAI key must already be saved.

## Background jobs

Locally, `src/server.ts` starts a worker that polls every 2 seconds.

On Vercel there is no long-running process. New jobs are drained with `waitUntil` after the request, and `GET /api/cron/jobs` can drain up to 10 pending jobs. Set `CRON_SECRET` so that route requires `Authorization: Bearer <CRON_SECRET>`.

Failed jobs retry with exponential backoff, up to 5 attempts. A `process_document` job that exhausts its attempts marks the document `failed`.

`purge_account` runs after the 7-day deletion grace period and removes the user, files, chunks, and chats.

## Atlas Vector Search

Create an index named `chunk_embedding_index` on the `chunks` collection. The definition is in `atlas-vector-index.json`:

- vector field `embedding`, 1536 dimensions, cosine similarity
- filter fields `userId` and `documentId`

On startup the API also tries to ensure this index exists. Atlas still needs vector search enabled on the cluster.

## Setup

Requirements: Node.js 20+, pnpm, a MongoDB Atlas database, a Cloudinary account, and a way to send email (Resend or SMTP).

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The server listens on `http://localhost:4000`.

Generate an encryption key (64 hex characters, 32 bytes):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | | HTTP port. Default `4000`. |
| `CLIENT_ORIGIN` | | Allowed browser origins, comma-separated. |
| `MONGODB_URI` | yes | Atlas connection string. |
| `JWT_SECRET` | yes | Signs session tokens. At least 16 characters. |
| `ENCRYPTION_KEY` | yes | 64 hex characters. Encrypts stored API keys. |
| `CLOUDINARY_CLOUD_NAME` | yes for uploads | Cloudinary cloud name. |
| `CLOUDINARY_API_KEY` | yes for uploads | Cloudinary API key. |
| `CLOUDINARY_API_SECRET` | yes for uploads | Cloudinary API secret. |
| `RESEND_API_KEY` | one mail path | Preferred when SMTP ports are blocked. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | one mail path | SMTP fallback for OTP email. |
| `EMAIL_LOGO_URL` | | Public HTTPS logo for OTP emails. |
| `CRON_SECRET` | | Protects `/api/cron/jobs` when set. |
| `NODE_ENV` | | `production` in deployed environments. |

Optional: `OTP_EXPIRY_MINUTES` (10), `OTP_RESEND_COOLDOWN_SECONDS` (60), `MAX_UPLOAD_BYTES` (1073741824), `VECTOR_INDEX_NAME` (`chunk_embedding_index`).

RAG constants in `src/config/env.ts` are fixed: embedding model, chunk size, chunk overlap, and OCR limits. They are not user settings.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start with hot reload (`tsx watch`) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run `dist/server.js` |
| `pnpm typecheck` | Typecheck without emitting files |

## Deploy

The API can run as a long-lived Node process or as a Vercel serverless function (`api/index.ts`).

1. Set the environment variables from `.env.example`.
2. Set `CLIENT_ORIGIN` to the frontend origin, for example `https://<your-app>.vercel.app`.
3. Set `NODE_ENV=production`.
4. In Atlas → Network Access, allow the deployment’s IP addresses.
5. Create the vector search index described above.
6. Point the frontend build at `https://<your-api>/api`.
