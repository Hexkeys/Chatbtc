const http = require('http');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const knowledge = [
  { keys: ['photosynthesis'], text: 'Photosynthesis is how plants use light energy to turn carbon dioxide and water into sugars, releasing oxygen. The overall simplified equation is: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂.' },
  { keys: ['black hole'], text: 'A black hole is a region of spacetime whose gravity is so strong that, past its event horizon, nothing can escape—not even light. We infer their presence from nearby matter, light, and gravitational waves.' },
  { keys: ['bitcoin', 'btc', 'blockchain'], text: 'Bitcoin is a decentralized digital currency. Transactions are grouped into blocks and secured by proof of work. Prices are volatile; I can explain concepts, but I cannot predict prices or provide live market data in this offline mode.' },
  { keys: ['javascript', 'node.js', 'nodejs'], text: 'JavaScript runs in browsers and on servers through runtimes such as Node.js. For a Render web service, listen on process.env.PORT and bind the HTTP server to the platform-provided port.' },
  { keys: ['render deploy', 'deploy on render'], text: 'For Render: create a Web Service from your GitHub repository, choose the Node runtime, set Build Command to npm install (or leave it empty for this dependency-free app), and Start Command to npm start. No API keys are required.' },
  { keys: ['machine learning', 'neural network'], text: 'Machine learning fits patterns from examples to make predictions. Neural networks use layers of parameterized transformations trained with an optimization algorithm. A genuinely capable generative model normally requires trained model weights; rules alone are not equivalent to a frontier LLM.' }
];
function calc(s) {
  const expr = s.replace(/,/g,'').match(/(?:what is|calculate|compute|solve|evaluate|equals?)\s+(.+?)\??$/i)?.[1] || (/^[\d\s()+\-*/%.^]+$/.test(s.trim()) ? s.trim() : null);
  if (!expr || expr.length > 100 || !/^[\d\s()+\-*/%.^]+$/.test(expr)) return null;
  try {
    const js = expr.replace(/\^/g,'**');
    const result = Function('"use strict"; return (' + js + ')')();
    return Number.isFinite(result) ? String(Number(result.toPrecision(12))) : null;
  } catch { return null; }
}
function answer(input, history=[]) {
  const raw = String(input || '').trim();
  if (!raw) return 'Ask me a question and I’ll work through it with you.';
  const s = raw.toLowerCase();
  const math = calc(raw);
  if (math !== null) return 'Let’s calculate it: **' + raw + ' = ' + math + '**';
  if (/^(hi|hello|hey|yo|good morning|good evening)\b/.test(s)) return 'Hey! I’m ChatBTC, your no-API-key assistant. I can explain concepts, help with code, brainstorm, summarize text you provide, and solve basic arithmetic. What are we working on?';
  if (/\b(who are you|what are you|your name)\b/.test(s)) return 'I’m ChatBTC, a lightweight assistant running entirely on this server with no external AI API. I use built-in knowledge, pattern matching, and utilities. I’m transparent about a key limitation: without a trained language model or external model service, I’m not equivalent to a state-of-the-art AI.';
  if (/\b(time|date|today)\b/.test(s)) return 'The server date is ' + new Date().toISOString().slice(0,10) + ' (UTC).';
  if (/\b(help|what can you do|capabilities)\b/.test(s)) return 'Here’s what I can do in this no-key edition:\n\n- Explain a few built-in science and technology topics\n- Calculate basic arithmetic (use “calculate (12 + 8) * 3”)\n- Offer JavaScript and Render deployment guidance\n- Help brainstorm, outline, rewrite, or summarize text you paste\n- Maintain the conversation context sent by the chat interface\n\nI don’t have live web access or a trained LLM, so I’ll say when a question is beyond my built-in knowledge.';
  if (/\b(summarize|summary)\b/.test(s) && raw.length > 100) return 'Summary of the text you provided:\n\n' + raw.slice(0, 700) + (raw.length > 700 ? '…\n\n(Quick extract only: this offline version does not have a full language model for semantic summarization.)' : '');
  for (const item of knowledge) if (item.keys.some(k => s.includes(k))) return item.text;
  if (/\b(write|draft|rewrite|improve|polish)\b/.test(s)) return 'I can help structure a draft. Tell me the audience, goal, and tone—or paste your current draft. This offline build can offer templates, but advanced rewriting requires a language model.';
  if (/\b(error|bug|debug|code|javascript|python|html|css)\b/.test(s)) return 'I can help troubleshoot. Share the relevant code, the exact error message, what you expected, and what happened. I’ll help you reason through it; note that this no-key version has limited built-in reasoning and does not execute your project code.';
  if (/\b(why|how|explain|what is|what are|when|where|who)\b/.test(s)) return 'Good question. I don’t have a trained language model behind this no-key build, and I don’t want to invent an answer. Try asking about Bitcoin, blockchain, photosynthesis, black holes, JavaScript, neural networks, or Render deployment—or provide source text for me to work with.';
  return 'I’m ready to help, but this no-API-key edition uses a small built-in knowledge base rather than a trained generative model. Add context or paste text and I’ll try a useful next step. For genuinely open-ended, high-quality AI responses, a trained model must run locally or be hosted somewhere; no API key alone does not create that model.';
}
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml'};
const server = http.createServer((req,res) => {
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify({ok:true, app:'ChatBTC', mode:'no-api-key'})); }
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body=''; req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', () => { try { const data=JSON.parse(body); const reply=answer(data.message, Array.isArray(data.history)?data.history.slice(-8):[]); res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); res.end(JSON.stringify({reply, mode:'offline'})); } catch { res.writeHead(400, {'content-type':'application/json'}); res.end(JSON.stringify({error:'Invalid request. Send JSON with a message string.'})); } });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
  const requested = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.resolve(ROOT, '.' + (requested === '/' ? '/index.html' : requested));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT,'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream','x-content-type-options':'nosniff'}); if (req.method === 'HEAD') return res.end(); res.end(data); });
});
server.listen(PORT, '0.0.0.0', () => console.log('ChatBTC listening on ' + PORT));
