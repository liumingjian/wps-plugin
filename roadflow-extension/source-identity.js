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
  const LIMITS = Object.freeze({
    compressedBytes: 25 * 1024 * 1024,
    archiveMembers: 2048,
    expansionRatio: 100,
    uncompressedBytes: 100 * 1024 * 1024
  });

  function parseXML(source, rootName, namespaces) {
    const document = new DOMParser().parseFromString(source, 'application/xml');
    const allowedNamespaces = Array.isArray(namespaces) ? namespaces : [namespaces];
    if (document.getElementsByTagName('parsererror').length ||
        document.documentElement?.localName !== rootName ||
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

  async function readXMLMember(entry) {
    const chunks = [];
    let byteCount = 0;
    const writable = new WritableStream({
      write(chunk) {
        byteCount += chunk.byteLength;
        if (byteCount > entry.uncompressedSize || byteCount > LIMITS.uncompressedBytes) {
          throw new Error('Expanded size limit exceeded');
        }
        chunks.push(Uint8Array.from(chunk));
      }
    });
    await entry.getData(writable);
    const bytes = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async function derive(sourceURL, expectedFormat) {
    try {
      const source = new URL(sourceURL);
      if (expectedFormat !== 'docx' || !/\.docx$/i.test(source.pathname)) throw new Error('Format mismatch');
      const response = await fetch(source.href, {
        cache: 'no-store',
        credentials: 'include',
        redirect: 'manual'
      });
      if (!response.ok || response.redirected || response.type === 'opaqueredirect' || response.url !== source.href) {
        throw new Error('Source response rejected');
      }

      const declaredSize = response.headers.get('Content-Length');
      if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > LIMITS.compressedBytes)) {
        throw new Error('Compressed size limit exceeded');
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > LIMITS.compressedBytes) throw new Error('Compressed size limit exceeded');
      zip.configure({ useWebWorkers: false });
      const reader = new zip.ZipReader(new zip.Uint8ArrayReader(bytes));
      try {
        const entries = await reader.getEntries();
        validateArchive(entries);
        const entriesByName = new Map(entries.map(entry => [entry.filename, entry]));
        const requiredNames = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
        if (!requiredNames.every(name => entriesByName.has(name))) throw new Error('Missing OOXML member');
        const files = new Map();
        for (const name of requiredNames) {
          files.set(name, await readXMLMember(entriesByName.get(name)));
        }
        validatePackageXML(files);
      } finally {
        await reader.close();
      }

      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return {
        ok: true,
        identity: {
          sourcePath: source.pathname,
          actualFormat: 'docx',
          byteCount: bytes.byteLength,
          sha256: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
        }
      };
    } catch {
      return { ok: false, message: FAILURE_MESSAGE };
    }
  }

  globalThis.RoadFlowSourceIdentity = Object.freeze({ derive });
})();
