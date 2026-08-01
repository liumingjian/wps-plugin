import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('./zip-core.min.js', import.meta.url), 'utf8'), { filename: 'zip-core.min.js' });
zip.configure({ useWebWorkers: false });

class TestDOMParser {
  parseFromString(source) {
    const root = source.match(/^\s*(?:<\?xml[^>]*>\s*)?<([\w.-]+:)?([\w.-]+)([^>]*)>/);
    const malformed = !root || source.includes('<malformed>') ||
      !new RegExp(`</${root?.[1] || ''}${root?.[2] || ''}>\\s*$`).test(source);
    const namespace = root?.[3].match(new RegExp(`xmlns${root?.[1] ? `:${root[1].slice(0, -1)}` : ''}="([^"]+)"`))?.[1] || '';
    return {
      documentElement: malformed ? undefined : { localName: root[2], namespaceURI: namespace },
      getElementsByTagName(name) { return name === 'parsererror' && malformed ? [{}] : []; },
      getElementsByTagNameNS(wantedNamespace, localName) {
        if (malformed || namespace !== wantedNamespace) return [];
        const matches = [...source.matchAll(new RegExp(`<([\\w.-]+:)?${localName}\\s+([^>]+?)/?>`, 'g'))];
        return matches.map(match => ({
          getAttribute(name) {
            return match[2].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
          }
        }));
      }
    };
  }
}
globalThis.DOMParser = TestDOMParser;

const contentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const relationships = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const documentXML = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>';

async function docx(entries = {}) {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter());
  const files = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': relationships,
    'word/document.xml': documentXML,
    ...entries
  };
  for (const [name, contents] of Object.entries(files)) {
    await writer.add(name, new zip.TextReader(contents));
  }
  return writer.close();
}

const sourceBytes = await docx();
const fetches = [];
let nextResponse;
function sourceResponse(bytes = sourceBytes, overrides = {}) {
  return {
    ok: true,
    status: 200,
    type: 'basic',
    redirected: false,
    url: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
    headers: { get() { return String(bytes.byteLength); } },
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    ...overrides
  };
}
globalThis.fetch = async (url, options) => {
  fetches.push({ url, options });
  const response = nextResponse || sourceResponse();
  nextResponse = undefined;
  return response;
};

vm.runInThisContext(await readFile(new URL('./source-identity.js', import.meta.url), 'utf8'), { filename: 'source-identity.js' });

const sourceURL = 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1';
const result = await RoadFlowSourceIdentity.derive(sourceURL, 'docx');
assert.deepEqual(result, {
  ok: true,
  identity: {
    sourcePath: '/documents/Quarterly%20Report.DOCX',
    actualFormat: 'docx',
    byteCount: sourceBytes.byteLength,
    sha256: createHash('sha256').update(sourceBytes).digest('hex')
  }
});
assert.deepEqual(fetches, [{
  url: sourceURL,
  options: { cache: 'no-store', credentials: 'include', redirect: 'manual' }
}]);

const strictRelationships = relationships.replace(
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'
);
const strictDocument = documentXML.replace(
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main'
);
nextResponse = sourceResponse(await docx({
  '_rels/.rels': strictRelationships,
  'word/document.xml': strictDocument
}));
assert.equal((await RoadFlowSourceIdentity.derive(sourceURL, 'docx')).ok, true);

const failure = { ok: false, message: 'Document verification failed. Editing was not opened.' };
for (const response of [
  sourceResponse(sourceBytes, { ok: false, status: 401 }),
  sourceResponse(sourceBytes, { ok: false, status: 500 }),
  sourceResponse(sourceBytes, { ok: false, status: 0, type: 'opaqueredirect', redirected: true }),
  sourceResponse(sourceBytes, { url: 'https://oa.example.test/login' }),
  sourceResponse(await docx({ 'word/document.xml': '<malformed>' }))
]) {
  nextResponse = response;
  assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);
}

const fetchCountBeforeFormatMismatch = fetches.length;
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'doc'), failure);
assert.equal(fetches.length, fetchCountBeforeFormatMismatch);

nextResponse = sourceResponse(sourceBytes, {
  headers: { get() { return String(25 * 1024 * 1024 + 1); } },
  async arrayBuffer() { throw new Error('oversized response body was read'); }
});
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

const manyEntries = {};
for (let index = 0; index < 2046; index += 1) manyEntries[`custom/item-${index}.xml`] = '<item/>';
nextResponse = sourceResponse(await docx(manyEntries));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

function inflatedMetadata(bytes, uncompressedSize) {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  for (let offset = 0; offset <= copy.length - 46; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, uncompressedSize, true);
      break;
    }
  }
  return copy;
}

nextResponse = sourceResponse(inflatedMetadata(sourceBytes, 1024 * 1024));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

nextResponse = sourceResponse(inflatedMetadata(sourceBytes, 100 * 1024 * 1024 + 1));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);
