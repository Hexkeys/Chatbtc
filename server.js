const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');

const knowledge = [
  { keys: ['photosynthesis'], text: 'Photosynthesis is how plants use light energy to turn carbon dioxide and water into sugars, releasing oxygen. The simplified equation is 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.' },
  { keys: ['black hole'], text: 'A black hole is a region of spacetime whose gravity is so strong that, past its event horizon, nothing can escape—not even light.' },
  { keys: ['bitcoin', 'btc', 'blockchain'], text: 'Bitcoin is a decentralized digital currency. Transactions are grouped into blocks and secured by proof of work. Prices are volatile; this service does not provide financial advice.' },
  { keys: ['javascript', 'node.js', 'nodejs'], text: 'JavaScript runs in browsers and on servers through runtimes such as Node.js. On Render, listen on process.env.PORT.' },
  { keys: ['machine learning', 'neural network'], text: 'Machine learning fits patterns from examples. Neural networks use layers of parameterized transformations trained with an optimization algorithm.' }
];

function calc(s) {
  const expr = s.replace(/,/g, '').match(/(?:what is|calculate|compute|solve|evaluate|equals?)\s+(.+?)\??$/i)?.[1] || (/^[\d\s()+\-*/%.^]+$/.test(s.trim()) ? s.trim() : null);
  if (!expr || expr.length > 100 || !/^[\d\s()+\-*/%.^]+$/.test(expr)) return null;
  try {
    const result = Function('"use strict"; return (' + expr.replace(/\^/g, '**') + ')')();
    return Number.isFinite(result) ? String(Number(result.toPrecision(12))) : null;
  } catch { return null; }
}

function decodeHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim();
}

async function searchWeb(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=wt-wt';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ChatBTC/1.0; +https://github.com/Hexkeys/Chatbtc)', 'accept': 'text/html' }
    });
    if (!response.ok) throw new Error('Search provider returned HTTP ' + response.status);
    const html = (await response.text()).slice(0, 1500000);
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
      if (!/^https?:\/\//i.test(resultUrl)) continue;
      let parsedUrl;
      try { parsedUrl = new URL(resultUrl); } catch { continue; }
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) continue;
      const title = decodeHtml(anchor[2]);
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
        || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
      const snippet = decodeHtml(snippetMatch?.[1] || '');
      if (title && !results.some(r => r.url === parsedUrl.href)) results.push({ title: title.slice(0, 220), url: parsedUrl.href, snippet: snippet.slice(0, 500), domain: parsedUrl.hostname });
      if (results.length >= 7) break;
    }
    return results;
  } finally {
    clearTimeout(timeout);
  }
}

function localAnswer(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'Ask me a question and I’ll search the web for useful sources.';
  const s = raw.toLowerCase();
  const math = calc(raw);
  if (math !== null) return 'Calculation: ' + raw + ' = ' + math;
  if (/^(hi|hello|hey|yo|good morning|good evening)\b/.test(s)) return 'Hey! I’m ChatBTC. Ask me a question and I’ll search the public web for relevant pages.';
  for (const item of knowledge) if (item.keys.some(k => s.includes(k))) return item.text;
  return 'I searched the web for: “' + raw + '”. Here are the most relevant results I could find. Open the sources to read more.';
}

function isRestrictedSearch(q) {
  return /\b(porn|pornography|gambling|sports betting|casino betting|buy (?:a )?(?:gun|firearm|weapon|ammunition)|make (?:a )?(?:bomb|explosive)|how to make (?:meth|fentanyl|poison)|suicide methods|how to self[- ]harm)\b/i.test(q);
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, app: 'ChatBTC', mode: 'web-search-no-api-key' }));
  }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const message = String(data.message || '').trim().slice(0, 500);
        if (!message) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Please enter a question.' })); }
        if (isRestrictedSearch(message)) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: 'I can’t search for that. Try a safe, educational question instead.', results: [], mode: 'blocked' }));
        }
        const math = calc(message);
        if (math !== null) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: 'Calculation: ' + message + ' = ' + math, results: [], mode: 'local' }));
        }
        try {
          const results = await searchWeb(message);
          const reply = results.length
            ? 'I searched the web for “' + message + '”. Here are the most relevant results I found. I can show search snippets, but I’m not a full language model and can’t independently verify every page.'
            : 'The web search returned no readable results for “' + message + '”. Try rephrasing your question.';
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply, results, mode: 'web' }));
        } catch (error) {
          const fallback = localAnswer(message);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ reply: fallback + '\n\nLive search is temporarily unavailable. Please try again shortly.', results: [], mode: 'offline' }));
        }
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
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
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('ChatBTC listening on ' + PORT));
