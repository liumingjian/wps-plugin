'use strict';

(() => {
  const DEBUG_PREFIX = '[RoadFlow WPS debug]';

  function debugURL(value) {
    try {
      const parsed = value instanceof URL ? value : new URL(String(value));
      if (parsed.protocol === 'blob:') return `blob:${parsed.pathname}`;
      return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}${parsed.hash ? '#[redacted]' : ''}`;
    } catch {
      return typeof value === 'string' ? value : undefined;
    }
  }

  function debugError(error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack };
    }
    return { message: String(error) };
  }

  function debug(event, details = {}) {
    if (!globalThis.chrome?.runtime?.id || typeof globalThis.console?.info !== 'function') return;
    console.info(`${DEBUG_PREFIX} ${event}`, details);
  }

  const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const WORD_NAMESPACES = [
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main'
  ];
  const DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
  const OFFICE_DOCUMENT_RELATIONSHIPS = [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'
  ];
  const FAILURE_MESSAGE = 'Document verification failed. Editing was not opened.';
  const DOC_FIB_LAYOUTS = [
    { nFib: 0x00c1, fcLcbCount: 0x005d, cswNew: 0 },
    { nFib: 0x00d9, fcLcbCount: 0x006c, cswNew: 2 },
    { nFib: 0x0101, fcLcbCount: 0x0088, cswNew: 2 },
    { nFib: 0x010c, fcLcbCount: 0x00a4, cswNew: 2 },
    { nFib: 0x0112, fcLcbCount: 0x00b7, cswNew: 5 }
  ];
  const LIMITS = Object.freeze({
    compressedBytes: RoadFlowSourceIdentityContract.MAX_COMPRESSED_BYTES,
    archiveMembers: 2048,
    expansionRatio: 100,
    uncompressedBytes: 100 * 1024 * 1024
  });

  function parseXMLDocument(source) {
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Unsupported OOXML declaration');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.getElementsByTagName('parsererror').length) throw new Error('Malformed OOXML');
    return document;
  }

  function parseXML(source, rootName, namespaces) {
    const document = parseXMLDocument(source);
    const allowedNamespaces = Array.isArray(namespaces) ? namespaces : [namespaces];
    if (document.documentElement?.localName !== rootName ||
        !allowedNamespaces.includes(document.documentElement?.namespaceURI)) throw new Error('Malformed OOXML');
    return document;
  }

  function validatePackageXML(files) {
    const contentTypes = parseXML(files.get('[Content_Types].xml'), 'Types', CONTENT_TYPES_NAMESPACE);
    const documentOverride = [...contentTypes.getElementsByTagNameNS(CONTENT_TYPES_NAMESPACE, 'Override')]
      .find(entry => entry.getAttribute('PartName') === '/word/document.xml');
    if (documentOverride?.getAttribute('ContentType') !== DOCUMENT_CONTENT_TYPE) throw new Error('Missing main Document content type');

    const relationships = parseXML(files.get('_rels/.rels'), 'Relationships', RELATIONSHIPS_NAMESPACE);
    const mainRelationship = [...relationships.getElementsByTagNameNS(RELATIONSHIPS_NAMESPACE, 'Relationship')]
      .find(entry => OFFICE_DOCUMENT_RELATIONSHIPS.includes(entry.getAttribute('Type')));
    if (mainRelationship?.getAttribute('Target') !== 'word/document.xml' ||
        mainRelationship.getAttribute('TargetMode') === 'External') throw new Error('Missing main Document relationship');
    parseXML(files.get('word/document.xml'), 'document', WORD_NAMESPACES);
  }

  function validateArchive(entries) {
    if (entries.length > LIMITS.archiveMembers) throw new Error('Archive member limit exceeded');
    const names = new Set();
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    for (const entry of entries) {
      if (typeof entry.filename !== 'string' || !entry.filename || names.has(entry.filename) ||
          entry.encrypted || entry.filename.includes('\\') || entry.filename.startsWith('/') ||
          entry.filename.split('/').includes('..')) throw new Error('Invalid archive member');
      names.add(entry.filename);
      for (const size of [entry.compressedSize, entry.uncompressedSize]) {
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive size');
      }
      compressedBytes += entry.compressedSize;
      uncompressedBytes += entry.uncompressedSize;
      if (!Number.isSafeInteger(compressedBytes) || !Number.isSafeInteger(uncompressedBytes)) {
        throw new Error('Invalid archive size');
      }
    }
    if (uncompressedBytes > LIMITS.uncompressedBytes) throw new Error('Expanded size limit exceeded');
    if (uncompressedBytes > Math.max(compressedBytes, 1) * LIMITS.expansionRatio) {
      throw new Error('Expansion ratio limit exceeded');
    }
  }

  async function readArchiveMember(entry, retain, expandedState) {
    const chunks = retain ? [] : undefined;
    let memberByteCount = 0;
    const writable = new WritableStream({
      write(chunk) {
        memberByteCount += chunk.byteLength;
        expandedState.byteCount += chunk.byteLength;
        if (memberByteCount > entry.uncompressedSize || expandedState.byteCount > LIMITS.uncompressedBytes) {
          throw new Error('Expanded size limit exceeded');
        }
        if (retain) chunks.push(Uint8Array.from(chunk));
      }
    });
    await entry.getData(writable, { checkSignature: true, checkOverlappingEntry: true });
    if (!retain) return undefined;
    const bytes = new Uint8Array(memberByteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function supportsRawDeflate() {
    if (typeof DecompressionStream !== 'function') return false;
    try {
      new DecompressionStream('deflate-raw');
      return true;
    } catch {
      return false;
    }
  }

  // Qaxbrowser's Chromium 102 exposes DecompressionStream but rejects deflate-raw.
  function legacyRawDeflateStream() {
    if (typeof TransformStream !== 'function' || !globalThis.CFB?.utils?._inflateRaw) return undefined;

    return class LegacyRawDeflateStream extends TransformStream {
      constructor(format) {
        if (format !== 'deflate-raw') throw new Error('Unsupported legacy ZIP compression');
        const chunks = [];
        super({
          transform(chunk) {
            chunks.push(Uint8Array.from(chunk));
          },
          flush(controller) {
            const compressedSize = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
            const compressed = new Uint8Array(compressedSize);
            let offset = 0;
            for (const chunk of chunks) {
              compressed.set(chunk, offset);
              offset += chunk.byteLength;
            }
            compressed.l = 0;
            const expanded = globalThis.CFB.utils._inflateRaw(compressed);
            if (compressed.l !== compressed.byteLength) throw new Error('Invalid compressed data');
            controller.enqueue(Uint8Array.from(expanded));
          }
        });
      }
    };
  }

  function configureZIP() {
    const options = { useWebWorkers: false };
    if (!supportsRawDeflate()) {
      const fallback = legacyRawDeflateStream();
      if (fallback) options.DecompressionStreamZlib = fallback;
    }
    zip.configure(options);
  }

  async function readBoundedSource(response) {
    if (!response.body?.getReader) throw new Error('Source body unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let byteCount = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteCount += value.byteLength;
        if (byteCount > LIMITS.compressedBytes) throw new Error('Compressed size limit exceeded');
        chunks.push(Uint8Array.from(value));
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      throw error;
    }
    if (!byteCount) throw new Error('Empty source');
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function validateDOC(bytes) {
    const container = CFB.parse(bytes);
    const rootPath = container.FullPaths?.[0];
    if (typeof rootPath !== 'string' || !rootPath.endsWith('/')) throw new Error('Invalid CFB root');
    const rootStream = name => {
      const index = container.FullPaths.indexOf(`${rootPath}${name}`);
      const entry = container.FileIndex?.[index];
      return entry?.type === 2 ? entry : undefined;
    };
    const wordDocument = rootStream('WordDocument');
    const contents = wordDocument?.content;
    if (!contents || contents.length < 154) throw new Error('Missing WordDocument FIB');
    const fibBytes = Uint8Array.from(contents.slice(0, 2048));
    const fib = new DataView(fibBytes.buffer);
    const baseNFib = fib.getUint16(2, true);
    const layout = DOC_FIB_LAYOUTS.find(candidate => candidate.fcLcbCount === fib.getUint16(152, true));
    if (fib.getUint16(0, true) !== 0xa5ec || !layout) {
      throw new Error('Invalid Word FIB');
    }
    const flags = fib.getUint16(10, true);
    if (!(flags & 0x1000) || (flags & 0x0100) ||
        ![0x00bf, 0x00c1].includes(fib.getUint16(12, true)) || fib.getUint32(14, true) !== 0 ||
        fib.getUint8(18) !== 0 || (fib.getUint8(19) & 1) !== 0 ||
        fib.getUint16(20, true) !== 0 || fib.getUint16(22, true) !== 0 ||
        fib.getUint16(32, true) !== 0x000e || fib.getUint16(62, true) !== 0x0016) {
      throw new Error('Invalid Word FIB base');
    }
    const cswNewOffset = 154 + layout.fcLcbCount * 8;
    if (fibBytes.length < cswNewOffset + 2 + layout.cswNew * 2 ||
        fib.getUint16(cswNewOffset, true) !== layout.cswNew ||
        (layout.cswNew === 0 ? baseNFib !== layout.nFib : fib.getUint16(cswNewOffset + 2, true) !== layout.nFib)) {
      throw new Error('Truncated Word FIB');
    }
    const tableName = flags & 0x0200 ? '1Table' : '0Table';
    if (!rootStream(tableName)?.content?.length) throw new Error('Missing Word table stream');
  }

  async function validateDOCX(bytes) {
    configureZIP();
    const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
    try {
      const entries = await reader.getEntries();
      validateArchive(entries);
      const entriesByName = new Map(entries.map(entry => [entry.filename, entry]));
      const requiredNames = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
      if (!requiredNames.every(name => entriesByName.has(name))) throw new Error('Missing OOXML member');
      const requiredNameSet = new Set(requiredNames);
      const files = new Map();
      const expandedState = { byteCount: 0 };
      for (const entry of entries) {
        if (entry.directory) continue;
        const retain = requiredNameSet.has(entry.filename);
        const xmlMember = /(?:\.xml|\.rels)$/i.test(entry.filename);
        const contents = await readArchiveMember(entry, retain || xmlMember, expandedState);
        if (xmlMember) parseXMLDocument(contents);
        if (retain) files.set(entry.filename, contents);
      }
      validatePackageXML(files);
    } finally {
      await reader.close();
    }
  }

  const SHA256_INITIAL = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotateRight(value, count) {
    return (value >>> count) | (value << (32 - count));
  }

  // HTTP pages in Qax Chromium 102 do not expose crypto.subtle.
  function sha256Fallback(bytes) {
    const bitLength = bytes.byteLength * 8;
    const paddedLength = ((bytes.byteLength + 9 + 63) >> 6) << 6;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.byteLength] = 0x80;
    const paddedView = new DataView(padded.buffer);
    paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

    let [h0, h1, h2, h3, h4, h5, h6, h7] = SHA256_INITIAL;
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        words[index] = paddedView.getUint32(offset + index * 4, false);
      }
      for (let index = 16; index < 64; index += 1) {
        const word15 = words[index - 15];
        const word2 = words[index - 2];
        const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
        const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;
      let f = h5;
      let g = h6;
      let h = h7;
      for (let index = 0; index < 64; index += 1) {
        const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ ((~e) & g);
        const temp1 = (h + sigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
        const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sigma0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
      h5 = (h5 + f) >>> 0;
      h6 = (h6 + g) >>> 0;
      h7 = (h7 + h) >>> 0;
    }

    const digest = new Uint8Array(32);
    const digestView = new DataView(digest.buffer);
    [h0, h1, h2, h3, h4, h5, h6, h7].forEach((value, index) => {
      digestView.setUint32(index * 4, value, false);
    });
    return digest;
  }

  async function sha256Digest(bytes) {
    const subtle = globalThis.crypto?.subtle;
    if (typeof subtle?.digest === 'function') {
      try {
        const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
        debug('source-hash-complete', { method: 'crypto.subtle', byteCount: bytes.byteLength });
        return digest;
      } catch (error) {
        debug('source-hash-native-failed', { error: debugError(error) });
      }
    }
    const digest = sha256Fallback(bytes);
    debug('source-hash-complete', { method: 'javascript-fallback', byteCount: bytes.byteLength });
    return digest;
  }

  async function derive(sourceURL, expectedFormat) {
    debug('source-validation-start', {
      sourceURL: debugURL(sourceURL),
      expectedFormat
    });
    try {
      const source = new URL(sourceURL);
      if (!['doc', 'docx'].includes(expectedFormat) ||
          !new RegExp(`\\.${expectedFormat}$`, 'i').test(source.pathname)) throw new Error('Format mismatch');
      const requestURL = new URL(source.href);
      requestURL.hash = '';
      debug('source-fetch-start', {
        sourceURL: debugURL(source),
        requestURL: debugURL(requestURL),
        credentials: 'include',
        cache: 'no-store',
        redirect: 'manual'
      });
      const response = await fetch(requestURL.href, {
        cache: 'no-store',
        credentials: 'include',
        redirect: 'manual'
      });
      debug('source-fetch-response', {
        requestURL: debugURL(requestURL),
        ok: response.ok,
        status: response.status,
        type: response.type,
        redirected: response.redirected,
        responseURL: debugURL(response.url)
      });
      if (!response.ok || response.redirected || response.type === 'opaqueredirect' || response.url !== requestURL.href) {
        throw new Error('Source response rejected');
      }

      const declaredSize = response.headers.get('Content-Length');
      debug('source-response-metadata', {
        contentLength: declaredSize,
        compressedLimit: LIMITS.compressedBytes
      });
      if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > LIMITS.compressedBytes)) {
        throw new Error('Compressed size limit exceeded');
      }
      const bytes = await readBoundedSource(response);
      debug('source-bytes-read', { byteCount: bytes.byteLength });
      if (expectedFormat === 'docx') await validateDOCX(bytes);
      else validateDOC(bytes);
      debug('source-structure-valid', { sourcePath: RoadFlowSourceIdentityContract.sourcePath(source), expectedFormat });

      const digest = await sha256Digest(bytes);
      const identity = {
        sourcePath: RoadFlowSourceIdentityContract.sourcePath(source),
        actualFormat: expectedFormat,
        byteCount: bytes.byteLength,
        sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
      };
      debug('source-validation-succeeded', {
        sourceURL: debugURL(source),
        sourcePath: identity.sourcePath,
        actualFormat: identity.actualFormat,
        byteCount: identity.byteCount,
        sha256: identity.sha256
      });
      return {
        ok: true,
        identity
      };
    } catch (error) {
      debug('source-validation-failed', {
        sourceURL: debugURL(sourceURL),
        expectedFormat,
        error: debugError(error)
      });
      if (globalThis.chrome?.runtime?.id) console.error('RoadFlow source validation failed:', error);
      return { ok: false, message: FAILURE_MESSAGE };
    }
  }

  globalThis.RoadFlowSourceIdentity = Object.freeze({ derive });
})();
