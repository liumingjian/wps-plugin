'use strict';

(() => {
  const MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;

  function sourcePath(value) {
    let parsed;
    try { parsed = value instanceof URL ? value : new URL(value); } catch { return undefined; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    try {
      const path = decodeURI(parsed.pathname);
      return path.startsWith('/') && !/[?#]/.test(path) ? path : undefined;
    } catch {
      return undefined;
    }
  }

  function validate(value, sourcePath, expectedFormat) {
    if (!value || value.sourcePath !== sourcePath || value.actualFormat !== expectedFormat ||
        !Number.isSafeInteger(value.byteCount) || value.byteCount <= 0 || value.byteCount > MAX_COMPRESSED_BYTES ||
        !/^[a-f0-9]{64}$/.test(value.sha256 || '')) return undefined;
    return {
      sourcePath: value.sourcePath,
      actualFormat: value.actualFormat,
      byteCount: value.byteCount,
      sha256: value.sha256
    };
  }

  globalThis.RoadFlowSourceIdentityContract = Object.freeze({ MAX_COMPRESSED_BYTES, sourcePath, validate });
})();
