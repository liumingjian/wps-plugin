'use strict';

(() => {
  const RECEIPT_MAX_AGE_MS = 30_000;
  const CLOCK_SKEW_MS = 1_000;
  const HANDOFF_PATTERN = /^[a-f0-9]{64}$/;
  const RECEIPT_KEYS = Object.freeze([
    'actualFormat', 'byteCount', 'deliveredAt', 'handoff', 'sha256', 'sourcePath'
  ]);

  function endpoints(template, sourcePath, handoffID) {
    if (typeof template !== 'string' || template.split('{sourcePath}').length !== 2) {
      throw new Error('Gateway template must contain the source path exactly once.');
    }
    if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/') ||
        sourcePath.includes('/../') || sourcePath.includes('/./') || /[?#]/.test(sourcePath)) {
      throw new Error('Gateway source path is invalid.');
    }
    if (!HANDOFF_PATTERN.test(handoffID || '')) {
      throw new Error('Gateway handoff identity is invalid.');
    }

    const documentURL = new URL(template.replace('{sourcePath}', encodeURIComponent(sourcePath)));
    if (documentURL.searchParams.has('_wpsHandoff')) {
      throw new Error('Gateway template must not provide its own cache key.');
    }
    documentURL.searchParams.set('_wpsHandoff', handoffID);

    const receiptURL = new URL(documentURL.origin);
    const pathSegments = documentURL.pathname.split('/');
    pathSegments[pathSegments.length - 1] = 'delivery-receipt';
    receiptURL.pathname = pathSegments.join('/');
    receiptURL.searchParams.set('handoff', handoffID);
    return Object.freeze({ documentURL: documentURL.href, receiptURL: receiptURL.href });
  }

  function validateReceipt(value, handoffID, sourceIdentity, now, attemptStartedAt) {
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        Object.keys(value).sort().join('\0') !== RECEIPT_KEYS.join('\0') ||
        value.handoff !== handoffID || value.sourcePath !== sourceIdentity?.sourcePath ||
        value.actualFormat !== sourceIdentity?.actualFormat || value.byteCount !== sourceIdentity?.byteCount ||
        value.sha256 !== sourceIdentity?.sha256 || typeof value.deliveredAt !== 'string') return undefined;

    const deliveredAt = Date.parse(value.deliveredAt);
    if (!Number.isFinite(deliveredAt) || deliveredAt < attemptStartedAt - CLOCK_SKEW_MS ||
        now - deliveredAt > RECEIPT_MAX_AGE_MS || deliveredAt > now + CLOCK_SKEW_MS) return undefined;
    return value;
  }

  globalThis.RoadFlowIdentityGate = Object.freeze({
    RECEIPT_MAX_AGE_MS,
    CLOCK_SKEW_MS,
    endpoints,
    validateReceipt
  });
})();
