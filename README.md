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

## Deploy on Render (free)

1. Push this repo to GitHub.
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Web Service** → connect **Knowra-api**  
   (or use Blueprint with `render.yaml`).
3. Build: `corepack enable && pnpm install --frozen-lockfile && pnpm build`  
   Start: `pnpm start`  
   Health check: `/api/health`
4. Set env vars (same as `.env.example`):
   - `MONGODB_URI`, `JWT_SECRET`, `ENCRYPTION_KEY`
   - `CLOUDINARY_*`, `SMTP_*`
   - `CLIENT_ORIGIN` = `https://<your-frontend>.onrender.com`
   - `NODE_ENV` = `production`
5. MongoDB Atlas → Network Access → allow `0.0.0.0/0`
6. Free tier **spins down after idle**; first request may be slow (cold start).
