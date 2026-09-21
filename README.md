# Knowra API

Express + TypeScript backend for Knowra.

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in MongoDB, Cloudinary, JWT_SECRET, ENCRYPTION_KEY, SMTP
pnpm dev
```

`ENCRYPTION_KEY` must be 64 hex characters (32 bytes), e.g.:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Atlas Vector Search

Create a vector search index named `chunk_embedding_index` on the `chunks` collection:

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1536,
      "similarity": "cosine"
    },
    { "type": "filter", "path": "userId" },
    { "type": "filter", "path": "documentId" }
  ]
}
```

## Scripts

- `pnpm dev` — start with hot reload
- `pnpm build` — compile TypeScript
- `pnpm start` — run compiled server

## Deploy on Vercel

1. Push this repo to GitHub (or deploy from the CLI with `vercel --prod`).
2. Set env vars (same as `.env.example`):
   - `MONGODB_URI`, `JWT_SECRET`, `ENCRYPTION_KEY`
   - `CLOUDINARY_*`, `SMTP_*` or `RESEND_API_KEY`
   - `CLIENT_ORIGIN` = `https://<your-frontend>.vercel.app`
   - `NODE_ENV` = `production`
3. MongoDB Atlas → Network Access → allow your deployment IPs (or `0.0.0.0/0` for simplicity).
