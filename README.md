# ChatBTC

A lightweight Node.js chat app for Render with **no AI API keys**. ChatBTC searches the public web, tries to open readable pages, extracts a small amount of article text, and creates locally generated extractive summaries with source links.

## Run locally

    npm start

Open http://localhost:3000. Node.js 18+ is required for built-in fetch.

## Deploy to Render

- Build command: npm install
- Start command: npm start
- No API keys or environment secrets are required.
- The service listens on Render's PORT and exposes /health.

## Features

- DuckDuckGo search, with Bing and Wikipedia fallbacks.
- Opens up to four relevant public pages per query when possible.
- Tries to extract readable content from the page's article, main, or body area.
- Creates short, local extractive summaries and links back to sources; if reading a page fails, it keeps the search snippet.
- Result deduplication, bounded cache, request-size limits, and network timeouts.
- Local arithmetic and instant greeting responses.
- Responsive chat UI and safe text rendering.

## Safety controls live in one file

Edit [safety-limits.js](./safety-limits.js) to adjust the app's limits and safety policies. That file centralizes:

- Request-body and message-length limits and JSON input validation.
- Blocked-request patterns and educational-only handling for certain hazardous procedural questions.
- The trusted educational-source list used for educational-only searches.
- Public URL rules, blocked local/private/reserved IP ranges, DNS resolution checks, redirect limits, network timeouts, and response-byte limits.
- Filtering out step-like procedural sentences from summaries of hazardous-topic sources.
- Static-file path checks and browser security headers.
- Search-result counts, page-reading limits, cache size/age, and summary lengths.

These are defence-in-depth checks, not a complete safety system. A search result is not automatically trustworthy simply because it is public. Educational-only requests are narrowed to sources from educational/government domains and a small allowlist of science references; replies aim at principles and safety context rather than step-by-step hazardous procedures. To change these controls, edit the file, commit it, and redeploy.

## Public web only

ChatBTC does **not** crawl the dark web or Tor. It searches public-web providers. If it cannot find or read an appropriate source, it says so rather than claiming it searched places it cannot access.

## Important limitation

ChatBTC does **not** run a real language model. Its summaries are generated locally by selecting sentences from fetched pages, so it cannot reliably synthesize information or reason like a trained AI model. Some sites block automated requests, use JavaScript-heavy pages, or provide content that is not readable as HTML. The app may fall back to search snippets; open the source links to check the full context. A genuine model-generated answer generally requires running a model yourself or connecting a model provider.

## Routes

- GET / — chat interface
- GET /health — health check
- POST /api/chat — accepts JSON {"message":"your question"}; returns reply, results, and mode.
