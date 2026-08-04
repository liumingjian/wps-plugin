'use strict';

const STORAGE_KEY = 'roadFlowIntegration';
const ALL_ORIGIN_PATTERNS = Object.freeze(['http://*/*', 'https://*/*']);

function failure(message) {
  return Object.freeze({ ok: false, message });
}

function parseHTTPURL(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) return undefined;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function originPattern(origin) {
  return `${origin}/*`;
}

function permissionPatterns(configuration) {
  return configuration?.trustedOrigin ? [originPattern(configuration.trustedOrigin)] : [...ALL_ORIGIN_PATTERNS];
}

function trustsOrigin(configuration, candidateOrigin) {
  if (!configuration || typeof configuration.trustedOrigin !== 'string') return false;
  let parsed;
  try { parsed = new URL(candidateOrigin); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  return !configuration.trustedOrigin || parsed.origin === configuration.trustedOrigin;
}

function validate(input) {
  if (input?.trustedOrigin === undefined || input.trustedOrigin === '') {
    return Object.freeze({
      ok: true,
      value: Object.freeze({ trustedOrigin: '' })
    });
  }
  const originURL = parseHTTPURL(input?.trustedOrigin);
  if (!originURL || originURL.pathname !== '/' || originURL.search || originURL.hash) {
    return failure('Trusted OA Origin must be one HTTP or HTTPS Origin without a path, credentials, query, or fragment.');
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      trustedOrigin: originURL.origin
    })
  });
}

globalThis.RoadFlowConfiguration = Object.freeze({
  STORAGE_KEY, ALL_ORIGIN_PATTERNS, originPattern, permissionPatterns, trustsOrigin, validate
});
