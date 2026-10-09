# ChatBTC

A lightweight Node.js chat app with **live web search and no AI API keys**. It uses DuckDuckGo's public HTML search page to find web results; no search API token is needed. Network access is required for live search.

## Run locally

```bash
npm start
```

Open http://localhost:3000. Node.js 18+ is recommended (built-in `fetch` is used).

## Deploy to Render

1. Connect this repository in Render as a Web Service (or use the included `render.yaml` Blueprint).
2. Build command: `npm install`
3. Start command: `npm start`
4. Deploy. No environment secrets or API keys are required.

The service listens on Render's `PORT` and exposes `/health` for health checks. Once a Render service is connected to this GitHub repository, new commits normally trigger a redeploy according to that service's Auto-Deploy setting.

## What it does

- Responsive chat interface.
- Searches the public web for questions and displays linked results and snippets.
- Basic arithmetic handled locally.
- Search results depend on DuckDuckGo availability and may change or be unavailable if the provider blocks automated requests.
- No external AI model is connected: ChatBTC returns search-result snippets rather than generating a fully reasoned, model-written synthesis. Search results can be incomplete or inaccurate; open the source pages to verify claims.

## Routes

- `GET /` — chat UI
- `GET /health` — health check
- `POST /api/chat` — JSON body `{"message":"your question","history":[]}`; returns a reply, result links, and snippets.
