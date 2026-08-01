'use strict';

const SOURCE_PATH_PLACEHOLDER = '{sourcePath}';
const STORAGE_KEY = 'roadFlowIntegration';

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

function validate(input) {
  const originURL = parseHTTPURL(input?.trustedOrigin);
  if (!originURL || originURL.pathname !== '/' || originURL.search || originURL.hash) {
    return failure('Trusted OA Origin must be one HTTP or HTTPS Origin without a path, credentials, query, or fragment.');
  }

  const template = input?.gatewayTemplate;
  if (typeof template !== 'string' || template.split(SOURCE_PATH_PLACEHOLDER).length !== 2) {
    return failure('Gateway template must contain exactly one {sourcePath} placeholder.');
  }
  const gatewayURL = parseHTTPURL(template.replace(SOURCE_PATH_PLACEHOLDER, encodeURIComponent('/document.docx')));
  if (!gatewayURL || gatewayURL.hash) {
    return failure('Gateway template must be one HTTP or HTTPS URL without credentials or a fragment.');
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({
      trustedOrigin: originURL.origin,
      gatewayTemplate: template
    })
  });
}

globalThis.RoadFlowConfiguration = Object.freeze({ SOURCE_PATH_PLACEHOLDER, STORAGE_KEY, originPattern, validate });
