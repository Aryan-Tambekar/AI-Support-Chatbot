# Verdant & Co Support Console

A small full-stack support workflow for the Datastraw assessment. Customers send a message through a signed webhook or the built-in Customer test view; an LLM writes a grounded suggestion; a signed-in agent reviews, edits, and approves it. No draft is exposed to a customer or sent automatically.

## Run locally

1. Copy `.env.example` to `.env`. `GEMINI_API_KEY` is required to generate drafts; all other defaults run locally.
2. Run `npm install`, then `npm run dev`.
3. Open the Vite URL (normally `http://localhost:5173`). Agent demo credentials: `agent@verdant.co` / `verdant-demo`.

The API runs on port 3001. For production: `npm run build && npm start`; the Express server serves the generated `dist/` frontend. A `Dockerfile` and `render.yaml` are included for a single-service Render deployment. Set all environment variables in the host. Use a managed PostgreSQL database and replace the SQLite data adapter with a pooled Postgres driver for multi-instance deployment; the current SQLite file is deliberately zero-setup for an assessment demo.

## API

- `POST /webhook`: verifies `X-Signature: sha256=<HMAC raw body>` using `WEBHOOK_SECRET`; expects the assessment payload and responds `201`/`200` for a duplicate.
- `POST /api/auth/login`: returns an 8-hour agent JWT.
- `GET /api/conversations`, `GET /api/conversations/:id`, `POST /api/drafts/:id/approve`, `POST /api/drafts/:id/retry`: agent JWT required.
- `POST /api/customer/messages` and `GET /api/customer/:customerId/conversation`: Customer test view APIs.

## Decisions and trade-offs

React/Vite and Express are simple, fast to review, and share one deployment boundary. SQLite is a relational database and provides reliable local persistence; PostgreSQL is the first deployment swap for concurrent workers. The knowledge base is small, so it is included directly in the LLM system context. At larger KB sizes I would retrieve ranked policy chunks with embeddings, carry citations, and evaluate grounding.

Each external event ID is idempotent, webhook signatures use constant-time comparison, and inputs are size-validated. Every meaningful backend, database, and AI event is appended to `logs/actions.jsonl`. AI failures do not lose the message: the agent sees a failed draft and can retry after configuration/service recovery. Authentication is intentionally demo-level (environment account + JWT); production would use password hashing/SSO, HTTPS, rate limiting, secret rotation, and tenant scoping.

## Required assessment answers

**2 a.m. failure:** The message remains saved and its draft shows as failed with a retry action, so the agent can still see and handle it the next morning. I would find the cause through structured `logs/actions.jsonl`, provider response monitoring, and production error alerts keyed by event and conversation IDs.

**Twenty brands:** I would add `brand_id` to every tenant-owned table and scope all auth and queries by membership before expanding functionality. I would also move policies to versioned per-brand records and use retrieval, because isolation and correct grounding become the primary risk.

## Testing and limits

`npm test` verifies invalid signatures, webhook persistence/idempotency, protected agent endpoints, approval, and customer-visible replies. `npm run build` verifies the frontend production bundle. The AI integration is real but requires a configured compatible key; tests deliberately exercise the safe failure path when one is absent. I used AI assistance to accelerate boilerplate and then corrected an initial customer-view state issue so generated customer IDs are returned by the ingestion result.
