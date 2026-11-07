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
1. Main decisions and time constraints: I prioritized implementing the core functionality, authentication, and webhook security. I chose SQLite instead of PostgreSQL due to time constraints, as it was quicker to configure and integrate.

2. AI usage and limitations: AI helped me accelerate development, debug issues. However, it sometimes produced generic code such as the API was waiting for AI response before completing delaying the process so I changed it to as now the AI response works in background and API dosen't have to wait.

## Required assessment answers

**2 a.m. failure:** The message remains saved and its draft shows as failed with a retry action, so the agent can still see and handle it the next morning. I would find the cause through structured `logs/actions.jsonl`, provider response monitoring, and production error alerts keyed by event and conversation IDs.

**Twenty brands:** I would add `brand_id` to every tenant-owned table and scope all auth and queries by membership before expanding functionality. I would also move policies to versioned per-brand records and use retrieval, because isolation and correct grounding become the primary risk.
