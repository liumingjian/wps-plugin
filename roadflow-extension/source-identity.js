'use strict';

(() => {
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

  async function derive(sourceURL, expectedFormat) {
    try {
      const source = new URL(sourceURL);
      if (!['doc', 'docx'].includes(expectedFormat) ||
          !new RegExp(`\\.${expectedFormat}$`, 'i').test(source.pathname)) throw new Error('Format mismatch');
      const requestURL = new URL(source.href);
      requestURL.hash = '';
      const response = await fetch(requestURL.href, {
        cache: 'no-store',
        credentials: 'include',
        redirect: 'manual'
      });
      if (!response.ok || response.redirected || response.type === 'opaqueredirect' || response.url !== requestURL.href) {
        throw new Error('Source response rejected');
      }

      const declaredSize = response.headers.get('Content-Length');
      if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > LIMITS.compressedBytes)) {
        throw new Error('Compressed size limit exceeded');
      }
      const bytes = await readBoundedSource(response);
      if (expectedFormat === 'docx') await validateDOCX(bytes);
      else validateDOC(bytes);

      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        ok: true,
        identity: {
          sourcePath: RoadFlowSourceIdentityContract.sourcePath(source),
          actualFormat: expectedFormat,
          byteCount: bytes.byteLength,
          sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
        }
      };
    } catch (error) {
      if (globalThis.chrome?.runtime?.id) console.error('RoadFlow source validation failed:', error);
      return { ok: false, message: FAILURE_MESSAGE };
    }
  }

  globalThis.RoadFlowSourceIdentity = Object.freeze({ derive });
})();
