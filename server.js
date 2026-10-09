'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {
  LIMITS,
  BLOCKED_SEARCH_REPLY,
  InputGuardError,
  getRequestPolicy,
  makeSafeSearchQuery,
  parseChatRequest,
  readRequestBody,
  safeFetchText,
  isAllowedUrlShape,
  isTrustedEducationalUrl,
  applySecurityHeaders
} = require('./safety-limits');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const cache = new Map();
const inFlight = new Map();

function calc(s) {
  const expr = s.replace(/,/g, '').match(/(?:what is|calculate|compute|solve|evaluate|equals?)\s+(.+?)\??$/i)?.[1] || (/^[\d\s()+\-*/%.^]+$/.test(s.trim()) ? s.trim() : null);
  if (!expr || expr.length > LIMITS.MAX_CALC_EXPRESSION_CHARS || !/^[\d\s()+\-*/%.^]+$/.test(expr)) return null;
  try {
    const result = Function('"use strict"; return (' + expr.replace(/\^/g, '**') + ')')();
    return Number.isFinite(result) ? String(Number(result.toPrecision(12))) : null;
  } catch { return null; }
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; } catch { return ' '; }
    })
    .replace(/&#x([\da-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      try { return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; } catch { return ' '; }
    })
    .replace(/\s+/g, ' ').trim();
}

function simplifiedQuery(query) {
  return query
    .replace(/^(please\s+)?(can you|could you|would you|tell me|explain|find|search for|look up|what is|what are|who is|who are|when did|where is|how does|how do|how can)\s+/i, '')
    .replace(/[?!.]+$/g, '').trim();
}

async function fetchText(url, accept = 'text/html') {
  const fetched = await safeFetchText(url, accept, {
    maxBytes: LIMITS.MAX_SEARCH_RESPONSE_BYTES,
    timeoutMs: LIMITS.SEARCH_TIMEOUT_MS
  });
  return fetched.text;
}

function parseSearchResultUrl(rawUrl, baseUrl) {
  try {
    const parsed = new URL(rawUrl, baseUrl);
    if (!isAllowedUrlShape(parsed.href)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(query) {
  const html = await fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=wt-wt');
  const blocks = html.split(/<div class="result\b/).slice(1);
  const results = [];

  for (const block of blocks) {
    const anchor = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;

    let rawUrl = anchor[1].replace(/&amp;/g, '&');
    try {
      const parsed = new URL(rawUrl, 'https://duckduckgo.com');
      const redirect = parsed.searchParams.get('uddg');
      if (redirect) rawUrl = redirect;
      else rawUrl = parsed.href;
    } catch { continue; }

    const parsedUrl = parseSearchResultUrl(rawUrl, 'https://duckduckgo.com');
    if (!parsedUrl) continue;
    const title = decodeHtml(anchor[2]);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = decodeHtml(snippetMatch?.[1] || '');

    if (title && !results.some(r => r.url === parsedUrl.href)) {
      results.push({
        title: title.slice(0, LIMITS.MAX_RESULT_TITLE_CHARS),
        url: parsedUrl.href,
        snippet: snippet.slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS),
        domain: parsedUrl.hostname,
        source: 'DuckDuckGo',
        pageRead: false
      });
    }
    if (results.length >= LIMITS.MAX_RESULTS_PER_PROVIDER) break;
  }

  if (!results.length) throw new Error('DuckDuckGo returned no parseable results');
  return results;
}

async function searchBing(query) {
  const html = await fetchText('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&count=' + LIMITS.MAX_RESULTS_PER_PROVIDER);
  const blocks = html.split(/<li class="b_algo"\b/i).slice(1);
  const results = [];

  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const parsedUrl = parseSearchResultUrl(anchor[1].replace(/&amp;/g, '&'), 'https://www.bing.com');
    if (!parsedUrl) continue;

    const title = decodeHtml(anchor[2]);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = decodeHtml(snippetMatch?.[1] || '');

    if (title && !results.some(r => r.url === parsedUrl.href)) {
      results.push({
        title: title.slice(0, LIMITS.MAX_RESULT_TITLE_CHARS),
        url: parsedUrl.href,
        snippet: snippet.slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS),
        domain: parsedUrl.hostname,
        source: 'Bing',
        pageRead: false
      });
    }
    if (results.length >= LIMITS.MAX_RESULTS_PER_PROVIDER) break;
  }

  if (!results.length) throw new Error('Bing returned no parseable results');
  return results;
}

async function searchWikipedia(query) {
  const url = 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent(query) + '&limit=' + LIMITS.MAX_RESULTS_PER_PROVIDER;
  const raw = await fetchText(url, 'application/json');
  const data = JSON.parse(raw);
  const results = (data.pages || []).map(page => {
    const title = String(page.title || '').slice(0, LIMITS.MAX_RESULT_TITLE_CHARS);
    return {
      title,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
      snippet: decodeHtml(page.description || page.excerpt || '').slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS),
      domain: 'en.wikipedia.org',
      source: 'Wikipedia',
      pageRead: false
    };
  }).filter(r => r.title && isAllowedUrlShape(r.url));

  if (!results.length) throw new Error('Wikipedia returned no results');
  return results;
}

async function searchOne(query) {
  const providers = [searchDuckDuckGo, searchBing, searchWikipedia];
  let lastError;
  for (const provider of providers) {
    try {
      return await provider(query);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('All search providers failed');
}

function searchWeb(query) {
  const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.time < LIMITS.CACHE_TTL_MS) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached.results);
  }
  if (inFlight.has(key)) return inFlight.get(key);

  const shortQuery = simplifiedQuery(query);
  const variants = shortQuery && shortQuery.toLowerCase() !== key ? [query, shortQuery] : [query];
  const work = Promise.allSettled(variants.map(searchOne)).then(outcomes => {
    const merged = [];
    const seen = new Set();
    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') continue;
      for (const item of outcome.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          merged.push(item);
        }
      }
    }
    if (!merged.length) {
      const failure = outcomes.find(x => x.status === 'rejected');
      if (failure) throw failure.reason;
    }

    const results = merged.slice(0, LIMITS.MAX_SEARCH_RESULTS);
    cache.set(key, { time: Date.now(), results });
    while (cache.size > LIMITS.MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
    return results;
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, work);
  return work;
}

function extractReadablePage(html) {
  const source = String(html || '');
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeHtml(titleMatch?.[1] || '').slice(0, LIMITS.MAX_RESULT_TITLE_CHARS);

  const articleMatch = source.match(/<article\b[^>]*>[\s\S]*?<\/article\s*>/i)
    || source.match(/<main\b[^>]*>[\s\S]*?<\/main\s*>/i)
    || source.match(/<body\b[^>]*>[\s\S]*?<\/body\s*>/i);
  let content = articleMatch ? articleMatch[0] : source;
  content = content
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|canvas|template|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/main)\b[^>]*>/gi, '. ')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' ');
  const text = decodeHtml(content).slice(0, LIMITS.MAX_PAGE_TEXT_CHARS);
  return { title, text };
}

function summarizePageText(text, query, educationalOnly) {
  const stopWords = new Set(['the', 'and', 'for', 'that', 'with', 'from', 'what', 'how', 'why', 'are', 'was', 'were', 'into', 'this', 'these', 'those', 'you', 'your', 'can', 'could', 'would', 'should', 'about', 'have', 'has', 'had', 'does', 'did', 'not', 'but', 'all', 'any', 'when', 'where', 'who', 'will', 'its']);
  const keywords = [...new Set((String(query).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(word => !stopWords.has(word)))];
  let sentences = String(text || '').match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  sentences = sentences.map(sentence => sentence.trim()).filter(sentence => sentence.length >= 45 && sentence.length <= 550);

  if (educationalOnly) {
    sentences = sentences.filter(sentence =>
      !/\b(?:step\s*\d+|first,|next,|then,|add\s+\d|mix until|heat to|boil until|pour into|attach the|connect the|collect the gas|procedure is|follow these steps)\b/i.test(sentence)
    );
  }
  if (!sentences.length) return '';

  const scored = sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const matches = keywords.reduce((count, word) => count + (lower.includes(word) ? 1 : 0), 0);
    return { sentence, index, score: matches * 5 + Math.min(sentence.length, 260) / 260 };
  });
  const selected = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, LIMITS.MAX_PAGE_SUMMARY_SENTENCES)
    .sort((a, b) => a.index - b.index)
    .map(item => item.sentence);
  return selected.join(' ').slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS);
}

async function readAndSummarizeResults(results, query, policy) {
  let eligible = results;
  if (policy === 'educational-only') {
    eligible = results.filter(result => isTrustedEducationalUrl(result.url));
  }

  const chosen = eligible.slice(0, LIMITS.MAX_PAGES_TO_READ);
  const summaries = await Promise.all(chosen.map(async result => {
    try {
      const fetched = await safeFetchText(result.url, 'text/html,application/xhtml+xml,text/plain;q=0.8', {
        maxBytes: LIMITS.MAX_PAGE_RESPONSE_BYTES,
        timeoutMs: LIMITS.PAGE_TIMEOUT_MS
      });
      if (!/(text\/html|application\/xhtml\+xml|text\/plain)/i.test(fetched.contentType)) return null;

      let page;
      if (/text\/plain/i.test(fetched.contentType)) {
        page = { title: result.title, text: fetched.text.replace(/\s+/g, ' ').trim().slice(0, LIMITS.MAX_PAGE_TEXT_CHARS) };
      } else {
        page = extractReadablePage(fetched.text);
      }
      if (page.text.length < 160) return null;

      const summary = summarizePageText(page.text, query, policy === 'educational-only');
      if (!summary) return null;

      const finalUrl = new URL(fetched.url);
      return {
        originalUrl: result.url,
        result: {
          ...result,
          title: page.title || result.title,
          url: finalUrl.href,
          domain: finalUrl.hostname,
          snippet: summary,
          pageRead: true,
          summarySource: 'Page content'
        }
      };
    } catch {
      // Keep the original search snippet if the page is blocked, unavailable, or unreadable.
      return null;
    }
  }));

  const byOriginalUrl = new Map();
  for (const item of summaries) {
    if (item) byOriginalUrl.set(item.originalUrl, item.result);
  }
  return eligible.map(result => byOriginalUrl.get(result.url) || result);
}

function makeAnswer(query, results, policy) {
  const pageSummaries = results.filter(result => result.pageRead && result.snippet).slice(0, 3);

  if (policy === 'educational-only') {
    let explanation;
    if (/\bwater\b/i.test(query) && /\boxygen\b/i.test(query)) {
      explanation = 'At a high level, electrolysis uses electrical energy to split water molecules into hydrogen and oxygen. It does not create oxygen alone: hydrogen is produced too. Hydrogen is flammable, and oxygen can make fires burn much more intensely, so I’ll keep this to the science and safety context rather than give a step-by-step gas-production procedure.';
    } else {
      explanation = 'I can give a scientific overview and discuss risks, but I won’t turn this into step-by-step instructions for a hazardous procedure.';
    }

    if (pageSummaries.length) {
      explanation += '\n\nWhat the public educational pages say:\n\n' + pageSummaries
        .map((result, index) => (index + 1) + '. ' + result.title + ': ' + result.snippet)
        .join('\n\n');
    } else if (!results.length) {
      explanation += '\n\nI couldn’t verify a suitable educational source in this search. Try a question about the underlying chemistry or scientific principles.';
    }
    return explanation;
  }

  if (!results.length) {
    return 'I couldn’t find readable public-web results for “' + query + '”. Try a shorter phrase or include a specific name, date, or place.';
  }

  if (pageSummaries.length) {
    return 'I opened and summarized readable public-web pages related to “' + query + '”. Here are the main points extracted from those pages:\n\n' +
      pageSummaries.map((result, index) => (index + 1) + '. ' + result.title + ': ' + result.snippet).join('\n\n') +
      '\n\nThe linked cards show the sources. These are locally generated extractive summaries, not answers from a trained AI model; open the sources to verify context.';
  }

  const useful = results.filter(result => result.snippet && result.snippet.length > 35).slice(0, 3);
  if (!useful.length) return 'I found pages about “' + query + '”, but couldn’t extract readable text. Open the source links below to check them.';
  return 'I found these search-result summaries for “' + query + '”:\n\n' +
    useful.map((result, index) => (index + 1) + '. ' + result.snippet).join('\n\n') +
    '\n\nI couldn’t read the full page text for these sources, so this overview uses search snippets only.';
}

function sendJson(res, statusCode, data) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, app: 'ChatBTC', mode: 'public-web-page-reading-with-central-safety-limits' });
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    (async () => {
      const body = await readRequestBody(req);
      const message = parseChatRequest(body);
      const policy = getRequestPolicy(message);

      if (policy === 'blocked') {
        return sendJson(res, 200, { reply: BLOCKED_SEARCH_REPLY, results: [], mode: 'blocked' });
      }

      if (policy === 'normal') {
        const math = calc(message);
        if (math !== null) {
          return sendJson(res, 200, { reply: 'Calculation: ' + message + ' = ' + math, results: [], mode: 'local' });
        }

        if (/^(hi|hello|hey|yo|good morning|good evening)[!. ]*$/i.test(message)) {
          return sendJson(res, 200, {
            reply: 'Hey! I’m ChatBTC. Ask me a question and I’ll search the public web, open readable pages, summarize them locally, and show source links.',
            results: [],
            mode: 'local'
          });
        }
      }

      let results = [];
      let searchError = false;
      const searchQuery = policy === 'educational-only' ? makeSafeSearchQuery(message) : message;
      try {
        results = await searchWeb(searchQuery);
      } catch {
        searchError = true;
      }

      if (policy === 'educational-only') {
        results = results.filter(result => isTrustedEducationalUrl(result.url));
      }

      results = await readAndSummarizeResults(results, message, policy);
      const reply = makeAnswer(message, results, policy);
      const mode = policy === 'educational-only'
        ? 'educational-only'
        : searchError
          ? 'offline'
          : results.some(result => result.pageRead) ? 'pages-read' : 'web';

      return sendJson(res, 200, { reply, results, mode });
    })().catch(error => {
      const statusCode = error instanceof InputGuardError ? error.statusCode : 400;
      const message = error instanceof InputGuardError
        ? error.message
        : 'Invalid request. Send JSON with a message string.';
      sendJson(res, statusCode, { error: message });
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }

  let requested;
  try {
    requested = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  const file = path.resolve(ROOT, '.' + (requested === '/' ? '/index.html' : requested));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': mime[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'public, max-age=300'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('ChatBTC listening on ' + PORT));
