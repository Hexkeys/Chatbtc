# ChatBTC

A lightweight Node.js chat app for Render. When `OPENAI_API_KEY` is configured, ChatBTC searches the public web, reads available pages, and uses the OpenAI Responses API to synthesize a natural answer grounded in that source material. Without a key, it falls back to local extractive summaries.

## Run locally

    npm start

Open http://localhost:3000. Node.js 18+ is required for built-in fetch. To enable model-generated answers, set `OPENAI_API_KEY` in your shell or hosting environment before starting the server. You can optionally set `OPENAI_MODEL`; the default is `gpt-6-luna`.

## Deploy to Render

- Build command: npm install
- Start command: npm start
- Set `OPENAI_API_KEY` as a Render environment secret to enable model-generated answers.
- `OPENAI_MODEL` is optional and defaults to `gpt-6-luna`.
- Keep the key out of source control and browser-side JavaScript. API usage may incur charges, so review provider usage and limits.
- The service listens on Render's PORT and exposes /health.

## Features

- DuckDuckGo search, with Bing and Wikipedia fallbacks.
- Opens up to four relevant public pages per query when possible.
- Tries to extract readable content from the page's article, main, or body area.
- Synthesizes answers from readable public source text using a language model, with source cards shown alongside the answer.
- Falls back to local extractive summaries and search snippets if no API key is configured or the model service is unavailable.
- Result deduplication, bounded cache, request-size limits, and network timeouts.
- Local arithmetic and instant greeting responses.
- Responsive chat UI and safe text rendering.

## Safety controls live in one file

Edit [safety-limits.js](./safety-limits.js) to adjust the app's limits and safety policies. That file centralizes:

- Request-body and message-length limits and JSON input validation.
- Blocked-request patterns and educational-only handling for certain hazardous procedural questions.
- The trusted educational-source list used for educational-only searches.
- Public URL rules, blocked local/private/reserved IP ranges, DNS resolution checks, redirect limits, network timeouts, and response-byte limits.
- Model instructions and educational-only response constraints for hazardous-topic requests.
- Filtering out step-like procedural sentences from summaries of hazardous-topic sources.
- Static-file path checks and browser security headers.
- Search-result counts, page-reading limits, cache size/age, and summary lengths.

These are defence-in-depth checks, not a complete safety system. A search result is not automatically trustworthy simply because it is public. Webpage text is treated as untrusted evidence rather than instructions, and educational-only requests are narrowed to sources from educational/government domains and a small allowlist of science references. Replies aim at principles and safety context rather than step-by-step hazardous procedures. To change these controls, edit the file, commit it, and redeploy.

## Public web only

ChatBTC does **not** crawl the dark web or Tor. It searches public-web providers. If it cannot find or read an appropriate source, it says so rather than claiming it searched places it cannot access.

## Model-generated answers

With `OPENAI_API_KEY` set, ChatBTC sends the user question and bounded public-source text to the OpenAI Responses API. The model synthesizes an answer in natural language instead of just listing extracted sentences. The app's existing public-web search, page-reading limits, blocked-request rules, and educational-only handling still apply. When readable sources are available, their links appear below the answer.

The model can give a brief explanation of its conclusion, but the app does not expose private hidden chain-of-thought or internal scratch work. Without a key, or if the API request fails, ChatBTC uses the local summary fallback and says so. The model request is time-limited and sets `store: false`; this is not a guarantee about every form of provider-side processing, so review the provider's current data controls before sending sensitive material.

Some websites block automated requests, use JavaScript-heavy pages, or provide content that is not readable as HTML. API calls may be billable. Set appropriate usage limits with the provider, and never place the secret key in the browser or commit it to GitHub.

## Routes

- GET / — chat interface
- GET /health — health check
- POST /api/chat — accepts JSON {"message":"your question"}; returns reply, results, and mode.
