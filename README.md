# ChatBTC

A lightweight Node.js chat app for Render with **no AI API keys**. It searches DuckDuckGo first, falls back to Bing if needed, then uses Wikipedia search as a final fallback. It combines a simplified query in parallel when useful, deduplicates sources, and summarizes search snippets into a quick overview. Repeated queries are cached in memory for three minutes to reduce latency.

## Run locally

```bash
npm start
``

Open http://localhost:3000. Node.js 18+ is required for built-in `fetch`.

## Deploy to Render

- Build command: `npm install`
- Start command: `npm start`
- No API keys or environment secrets required.
- The service listens on Render's `PORT` and exposes `/health`.

## Features

- Responsive chat UI with clickable source links.
- Parallel search for the original and simplified query when useful.
- Automatic provider fallback: DuckDuckGo → Bing → Wikipedia.
- Search result deduplication, bounded in-memory cache, and request timeouts.
- Local arithmetic and instant greeting responses.
- Basic request-size limit and safe DOM rendering for search results.

## Edit safety rules and limits

Open [`safety-limits.js`](./safety-limits.js) to adjust the app's built-in limits and blocked-search patterns. The `LIMITS` section controls request/message size, search timeouts, cache size/age, result counts, snippet lengths, and calculator expression length. The `BLOCKED_SEARCH_PATTERNS` list controls which search requests are blocked, and `BLOCKED_SEARCH_REPLY` controls the message shown when a request is blocked. These are basic keyword rules, not a complete safety system. After editing the file, commit the change and redeploy the app for it to take effect.

## Important limitation

ChatBTC does **not** run a real language model. It creates a quick overview from search-result snippets, so it cannot reason like a frontier AI or reliably synthesize full articles. Search providers can block automated requests; fallback providers improve resilience but cannot guarantee availability, and results may be incomplete. Always open the cited sources for context. A genuine AI model that writes original answers generally requires running a model yourself or connecting a model provider; this repository is designed to remain key-free.

## Routes

- `GET /` — chat interface
- `GET /health` — health check
- `POST /api/chat` — accepts JSON `{"message":"your question"}`; returns `reply`, `results`, and `mode`.
