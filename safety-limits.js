'use strict';

/*
 * ChatBTC safety and limits configuration.
 *
 * Edit this file to adjust the app's built-in limits and search restrictions.
 * Keep rules specific and test them before deploying. These checks are basic
 * keyword filters, not a complete safety system.
 */

const LIMITS = Object.freeze({
  // Incoming request and message limits
  MAX_REQUEST_BODY_CHARS: 12000,
  MAX_MESSAGE_CHARS: 500,

  // Search reliability and resource limits
  SEARCH_TIMEOUT_MS: 6500,
  MAX_FETCHED_TEXT_CHARS: 1200000,
  CACHE_TTL_MS: 3 * 60 * 1000,
  MAX_CACHE_ITEMS: 150,
  MAX_SEARCH_RESULTS: 8,
  MAX_RESULTS_PER_PROVIDER: 8,
  MAX_RESULT_TITLE_CHARS: 220,
  MAX_RESULT_SNIPPET_CHARS: 500,

  // Basic local arithmetic input limit
  MAX_CALC_EXPRESSION_CHARS: 100
});

// Add or remove patterns here to change which search requests are blocked.
// Patterns are tested against the user's message, case-insensitively.
const BLOCKED_SEARCH_PATTERNS = [
  /\b(porn|pornography)\b/i,
  /\b(gambling|sports betting|casino betting)\b/i,
  /\bbuy (?:a )?(?:gun|firearm|weapon|ammunition)\b/i,
  /\bmake (?:a )?(?:bomb|explosive)\b/i,
  /\bhow to make (?:meth|fentanyl|poison)\b/i,
  /\b(suicide methods|how to self[- ]harm)\b/i
];

const BLOCKED_SEARCH_REPLY =
  'I can’t search for that. Try a safe, educational question instead.';

function isRestrictedSearch(message) {
  const text = String(message || '');
  return BLOCKED_SEARCH_PATTERNS.some(pattern => pattern.test(text));
}

module.exports = {
  LIMITS,
  BLOCKED_SEARCH_PATTERNS,
  BLOCKED_SEARCH_REPLY,
  isRestrictedSearch
};
