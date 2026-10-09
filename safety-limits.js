'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const path = require('node:path');

/*
 * ChatBTC safety policy and resource limits.
 *
 * Keep request validation, content restrictions, hazardous-procedure handling,
 * public-URL checks, redirect checks, response-size bounds, and network timeouts
 * in this file. These checks reduce risk; they are not a complete safety system.
 */

const LIMITS = Object.freeze({
  MAX_REQUEST_BODY_CHARS: 12000,
  MAX_MESSAGE_CHARS: 500,

  SEARCH_TIMEOUT_MS: 6500,
  PAGE_TIMEOUT_MS: 5000,
  MAX_SEARCH_RESPONSE_BYTES: 600000,
  MAX_PAGE_RESPONSE_BYTES: 250000,
  MAX_PAGE_TEXT_CHARS: 20000,
  MAX_PAGES_TO_READ: 4,
  MAX_REDIRECTS: 3,

  CACHE_TTL_MS: 3 * 60 * 1000,
  MAX_CACHE_ITEMS: 150,
  MAX_SEARCH_RESULTS: 8,
  MAX_RESULTS_PER_PROVIDER: 8,
  MAX_RESULT_TITLE_CHARS: 220,
  MAX_RESULT_SNIPPET_CHARS: 500,
  MAX_PAGE_SUMMARY_SENTENCES: 3,

  MAX_CALC_EXPRESSION_CHARS: 100
});

// Requests matching these patterns do not receive search results.
const BLOCKED_SEARCH_PATTERNS = [
  /\b(porn|pornography)\b/i,
  /\b(gambling|sports betting|casino betting)\b/i,
  /\bbuy (?:a )?(?:gun|firearm|weapon|ammunition)\b/i,
  /\bmake (?:a )?(?:bomb|explosive)\b/i,
  /\bhow to make (?:meth|fentanyl|poison)\b/i,
  /\b(suicide methods|how to self[- ]harm)\b/i
];

const BLOCKED_SEARCH_REPLY =
  'I can’t help search for that request. Try a safe, educational question instead.';

// For these requests, searches are narrowed to reputable educational sources and
// the response is limited to scientific principles and safety context, not a how-to.
const EDUCATIONAL_ONLY_PATTERNS = [
  /\bhow\s+to\b.{0,100}\b(?:convert|turn|split)\s+water\s+(?:into|to)\s+(?:pure\s+)?oxygen\b/i,
  /\b(?:convert|turn|split)\s+water\s+(?:into|to)\s+(?:pure\s+)?oxygen\b/i,
  /\bhow\s+to\b.{0,100}\b(?:make|produce|extract|generate|concentrate|collect)\b.{0,60}\b(?:pure\s+)?oxygen\b/i,
  /\b(?:step[- ]by[- ]step|instructions?|recipe|procedure)\b.{0,100}\b(?:electrolysis|oxygen generation|chlorine gas|hydrogen gas)\b/i,
  /\bhow\s+to\b.{0,100}\b(?:generate|make|produce|concentrate|collect)\b.{0,70}\b(?:chlorine gas|toxic gas|hydrogen gas|highly concentrated oxygen)\b/i,
  /\b(?:how\s+to|steps?\s+to|step[- ]by[- ]step|instructions?\s+(?:to|for)|guide\s+to|recipe\s+for)\b.{0,120}\b(?:make|build|synthesize|produce|extract|generate|concentrate|weaponize|assemble|create)\b.{0,100}\b(?:bomb|explosive|poison|toxin|meth|fentanyl|weapon|malware|ransomware|chlorine gas|toxic gas|hydrogen gas|highly concentrated oxygen)\b/i
];

const EDUCATIONAL_REPLY_OXYGEN = 'At a high level, electrolysis uses electrical energy to split water molecules into hydrogen and oxygen. It does not create oxygen alone: hydrogen is produced too. Hydrogen is flammable, and oxygen can make fires burn much more intensely, so I’ll keep this to the science and safety context rather than give a step-by-step gas-production procedure.';
const EDUCATIONAL_REPLY_GENERAL = 'I can give a scientific overview and discuss risks, but I won’t turn this into step-by-step instructions for a hazardous procedure.';
const NO_TRUSTED_SOURCE_REPLY = 'I couldn’t verify a suitable educational source in this search. Try a question about the underlying scientific principles or safety context.';

const TRUSTED_EDUCATIONAL_DOMAINS = [
  'edu', 'gov', 'rsc.org', 'acs.org', 'chem.libretexts.org',
  'openstax.org', 'nist.gov', 'nih.gov', 'cdc.gov', 'energy.gov',
  'sciencehistory.org', 'wikipedia.org'
];

class InputGuardError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'InputGuardError';
    this.statusCode = statusCode;
  }
}

function isRestrictedSearch(message) {
  const value = String(message || '');
  return BLOCKED_SEARCH_PATTERNS.some(pattern => pattern.test(value));
}

function getRequestPolicy(message) {
  if (isRestrictedSearch(message)) return 'blocked';
  if (EDUCATIONAL_ONLY_PATTERNS.some(pattern => pattern.test(String(message || '')))) {
    return 'educational-only';
  }
  return 'normal';
}

function makeSafeSearchQuery(message) {
  const value = String(message || '').trim();
  const oxygenQuestion =
    /\bwater\b/i.test(value) &&
    /\boxygen\b/i.test(value) &&
    /\b(?:how|convert|turn|split|make|produce|extract|generate|electrolysis)\b/i.test(value);

  if (oxygenQuestion) {
    return 'water electrolysis chemistry principles oxygen hydrogen safety educational site:edu OR site:gov';
  }

  return value + ' scientific principles safety educational overview site:edu OR site:gov';
}

function parseChatRequest(body) {
  let data;
  try {
    data = JSON.parse(String(body || ''));
  } catch {
    throw new InputGuardError('Invalid JSON request.');
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new InputGuardError('Send JSON with a message string.');
  }
  if (typeof data.message !== 'string') {
    throw new InputGuardError('The message must be text.');
  }

  const message = data.message.trim();
  if (!message) throw new InputGuardError('Please enter a question.');
  if (message.length > LIMITS.MAX_MESSAGE_CHARS) {
    throw new InputGuardError('Your message is too long. Please keep it under ' + LIMITS.MAX_MESSAGE_CHARS + ' characters.', 413);
  }
  return message;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let chunks = [];
    let failed = false;

    req.on('data', chunk => {
      if (failed) return;
      total += chunk.length;
      if (total > LIMITS.MAX_REQUEST_BODY_CHARS) {
        failed = true;
        chunks = [];
        reject(new InputGuardError('Request body is too large.', 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', error => {
      if (!failed) reject(error);
    });
    req.on('aborted', () => {
      if (!failed) reject(new InputGuardError('Request was interrupted.'));
    });
  });
}

function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const p = address.split('.').map(Number);
    const a = p[0], b = p[1], c = p[2];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }

  if (version === 6) {
    const ip = address.toLowerCase().split('%')[0];
    // Only allow globally-routable unicast space (2000::/3), excluding known
    // documentation, transition, and tunnelling ranges.
    if (!(ip.startsWith('2') || ip.startsWith('3'))) return false;
    if (ip.startsWith('2001:db8:') || ip.startsWith('2002:') || ip.startsWith('2001:0:')) return false;
    return true;
  }
  return false;
}


function isAllowedUrlShape(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  if (url.port && !['80', '443'].includes(url.port)) return false;

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      hostname.endsWith('.test') || hostname === 'metadata.google.internal' ||
      hostname === 'metadata') return false;
  if (net.isIP(hostname) && !isPublicIp(hostname)) return false;
  return true;
}

async function assertPublicHttpUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('Invalid source URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS sources are allowed');
  if (url.username || url.password) throw new Error('Source URLs with credentials are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Non-standard source ports are not allowed');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || hostname.endsWith('.internal') ||
      hostname.endsWith('.test') || hostname === 'metadata.google.internal' ||
      hostname === 'metadata') {
    throw new Error('Local and internal source addresses are blocked');
  }

  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Private or reserved source addresses are blocked');
    return url;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Could not resolve source hostname');
  }
  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) {
    throw new Error('Private or reserved source addresses are blocked');
  }
  return url;
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const item = await reader.read();
      if (item.done) break;

      const chunk = Buffer.from(item.value);
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  return Buffer.concat(chunks, total).toString('utf8');
}

async function safeFetchText(rawUrl, accept = 'text/html', options = {}) {
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? Math.min(options.maxBytes, LIMITS.MAX_SEARCH_RESPONSE_BYTES)
    : LIMITS.MAX_SEARCH_RESPONSE_BYTES;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, LIMITS.PAGE_TIMEOUT_MS)
    : LIMITS.SEARCH_TIMEOUT_MS;

  let currentUrl = String(rawUrl);
  for (let redirects = 0; redirects <= LIMITS.MAX_REDIRECTS; redirects++) {
    const checkedUrl = await assertPublicHttpUrl(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(checkedUrl.href, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'user-agent': 'ChatBTC/2.2 (public-page summary; https://github.com/Hexkeys/Chatbtc)',
          'accept': accept
        }
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (response.body) await response.body.cancel().catch(() => {});
        if (!location) throw new Error('Source redirected without a location');
        if (redirects === LIMITS.MAX_REDIRECTS) throw new Error('Too many source redirects');
        currentUrl = new URL(location, checkedUrl).href;
        continue;
      }

      if (!response.ok) throw new Error('Source returned HTTP ' + response.status);
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      const text = await readBoundedResponse(response, maxBytes);
      return { text, url: checkedUrl.href, contentType, status: response.status };
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Too many source redirects');
}

function isTrustedEducationalUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (hostname.endsWith('.edu') || hostname.endsWith('.gov')) return true;
    return TRUSTED_EDUCATIONAL_DOMAINS.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}


function isOxygenQuestion(message) {
  const value = String(message || '');
  return /\bwater\b/i.test(value) && /\boxygen\b/i.test(value) &&
    /\b(?:how|convert|turn|split|make|produce|extract|generate|electrolysis)\b/i.test(value);
}

function filterEducationalSummarySentences(sentences) {
  return sentences.filter(sentence =>
    !/\b(?:step\s*\d+|first,|next,|then,|add\s+\d|mix until|heat to|boil until|pour into|attach the|connect the|collect the gas|procedure is|follow these steps)\b/i.test(sentence)
  );
}

function normalizeAllowedSourceUrl(rawUrl, baseUrl) {
  try {
    const parsed = baseUrl ? new URL(String(rawUrl), baseUrl) : new URL(String(rawUrl));
    return isAllowedUrlShape(parsed.href) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveStaticFile(root, requestUrl) {
  let requested;
  try {
    requested = decodeURIComponent((String(requestUrl || '/')).split('?')[0]);
  } catch {
    throw new InputGuardError('Bad request path.', 400);
  }

  const file = path.resolve(root, '.' + (requested === '/' ? '/index.html' : requested));
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) {
    throw new InputGuardError('Forbidden path.', 403);
  }
  return file;
}

function applySecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
}

module.exports = {
  LIMITS,
  BLOCKED_SEARCH_PATTERNS,
  BLOCKED_SEARCH_REPLY,
  EDUCATIONAL_ONLY_PATTERNS,
  InputGuardError,
  isRestrictedSearch,
  getRequestPolicy,
  makeSafeSearchQuery,
  parseChatRequest,
  readRequestBody,
  isPublicIp,
  isAllowedUrlShape,
  normalizeAllowedSourceUrl,
  resolveStaticFile,
  filterEducationalSummarySentences,
  isOxygenQuestion,
  EDUCATIONAL_REPLY_OXYGEN,
  EDUCATIONAL_REPLY_GENERAL,
  NO_TRUSTED_SOURCE_REPLY,
  assertPublicHttpUrl,
  safeFetchText,
  isTrustedEducationalUrl,
  applySecurityHeaders
};
