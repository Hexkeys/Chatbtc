# ChatBTC

A lightweight chatbot that runs on Node.js and deploys to Render **without API keys or third-party runtime dependencies**.

## Run locally

```bash
npm start
```

Open http://localhost:3000. Node.js 18+ is recommended.

## Deploy to Render

1. Push this repository to GitHub.
2. In Render, create a new **Web Service** and connect this repository (or use the included `render.yaml` Blueprint).
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy. No environment secrets or API keys are needed.

The service listens on Render's `PORT` and exposes `/health` for health checks.

## What this is—and isn't

This version includes a responsive chat interface, a small built-in knowledge base, basic arithmetic, and a few programming/deployment hints. It does not call an external AI API and does not contain a trained large language model. As a result, it cannot honestly match frontier assistants or reliably answer arbitrary questions. To achieve more capable open-ended generation while keeping API keys out of the picture, a trained open-weight model would need to be hosted and run on suitable hardware; that has nontrivial compute and memory requirements.

## Routes

- `GET /` — chat UI
- `GET /health` — health check
- `POST /api/chat` — JSON body `{"message":"...","history":[]}`
