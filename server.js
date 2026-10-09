const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const { LIMITS, BLOCKED_SEARCH_REPLY, isRestrictedSearch } = require('./safety-limits');
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
  return String(s || '').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ').trim();
}

function simplifiedQuery(query) {
  return query
    .replace(/^(please\s+)?(can you|could you|would you|tell me|explain|find|search for|look up|what is|what are|who is|who are|when did|where is|how does|how do|how can)\s+/i, '')
    .replace(/[?!.]+$/g, '').trim();
}

async function fetchText(url, accept = 'text/html') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIMITS.SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'ChatBTC/2.1 (https://github.com/Hexkeys/Chatbtc)',
        'accept': accept
      }
    });
    if (!response.ok) throw new Error('Search provider returned HTTP ' + response.status);
    return (await response.text()).slice(0, LIMITS.MAX_FETCHED_TEXT_CHARS);
  } finally {
    clearTimeout(timeout);
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
    let resultUrl = anchor[1].replace(/&amp;/g, '&');
    try {
      const parsed = new URL(resultUrl, 'https://duckduckgo.com');
      const redirect = parsed.searchParams.get('uddg');
      if (redirect) resultUrl = redirect;
    } catch { continue; }
    let parsedUrl;
    try { parsedUrl = new URL(resultUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const title = decodeHtml(anchor[2]);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = decodeHtml(snippetMatch?.[1] || '');
    if (title && !results.some(r => r.url === parsedUrl.href)) {
      results.push({ title: title.slice(0, LIMITS.MAX_RESULT_TITLE_CHARS), url: parsedUrl.href, snippet: snippet.slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS), domain: parsedUrl.hostname, source: 'DuckDuckGo' });
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
    let parsedUrl;
    try { parsedUrl = new URL(anchor[1].replace(/&amp;/g, '&')); } catch { continue; }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const title = decodeHtml(anchor[2]);
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = decodeHtml(snippetMatch?.[1] || '');
    if (title && !results.some(r => r.url === parsedUrl.href)) {
      results.push({ title: title.slice(0, LIMITS.MAX_RESULT_TITLE_CHARS), url: parsedUrl.href, snippet: snippet.slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS), domain: parsedUrl.hostname, source: 'Bing' });
    }
    if (results.length >= 8) break;
  }
  if (!results.length) throw new Error('Bing returned no parseable results');
  return results;
}

async function searchWikipedia(query) {
  const url = 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent(query) + '&limit=' + LIMITS.MAX_RESULTS_PER_PROVIDER;
  const raw = await fetchText(url, 'application/json');
  const data = JSON.parse(raw);
  const results = (data.pages || []).map(page => ({
    title: String(page.title || '').slice(0, LIMITS.MAX_RESULT_TITLE_CHARS),
    url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(page.title || '').replace(/ /g, '_')),
    snippet: decodeHtml(page.description || page.excerpt || '').slice(0, LIMITS.MAX_RESULT_SNIPPET_CHARS),
    domain: 'en.wikipedia.org',
    source: 'Wikipedia'
  })).filter(r => r.title);
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
    cache.delete(key); cache.set(key, cached);
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
        if (!seen.has(item.url)) { seen.add(item.url); merged.push(item); }
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

function makeAnswer(query, results) {
  if (!results.length) return 'I couldn’t find readable search results for “' + query + '”. Try a shorter phrase or include a specific name, date, or place.';
  const useful = results.filter(r => r.snippet && r.snippet.length > 35).slice(0, 4);
  if (!useful.length) return 'I found web pages about “' + query + '”. Open the source links below to read the details.';
  const lines = useful.slice(0, 3).map((r, i) => (i + 1) + '. ' + r.snippet);
  return 'Here’s a quick answer based on live web search for “' + query + '”:\n\n' + lines.join('\n\n') + '\n\nThese are search-snippet summaries, not a response from a trained AI model. Open the linked sources below to check context and details.';
}


const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  res.setHeader('x-content-type-options', 'nosniff');
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, app: 'ChatBTC', mode: 'cached-parallel-web-search-no-api-key' }));
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > LIMITS.MAX_REQUEST_BODY_CHARS) { res.writeHead(413, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Message is too large.' })); req.destroy(); }
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const data = JSON.parse(body);
        const message = String(data.message || '').trim().slice(0, LIMITS.MAX_MESSAGE_CHARS);
        if (!message) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Please enter a question.' })); }
        if (isRestrictedSearch(message)) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: BLOCKED_SEARCH_REPLY, results: [], mode: 'blocked' }));
        }
        const math = calc(message);
        if (math !== null) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: 'Calculation: ' + message + ' = ' + math, results: [], mode: 'local' }));
        }
        if (/^(hi|hello|hey|yo|good morning|good evening)[!. ]*$/i.test(message)) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: 'Hey! I’m ChatBTC. Ask me a question and I’ll search the web and summarize useful snippets with source links.', results: [], mode: 'local' }));
        }
        try {
          const results = await searchWeb(message);
          const reply = makeAnswer(message, results);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply, results, mode: 'web' }));
        } catch {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: 'Live web search is temporarily unavailable. Please try again shortly.', results: [], mode: 'offline' }));
        }
      } catch {
        if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request. Send JSON with a message string.' }));
      }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
  let requested;
  try { requested = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end('Bad request'); }
  const file = path.resolve(ROOT, '.' + (requested === '/' ? '/index.html' : requested));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('ChatBTC listening on ' + PORT));
