import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('./zip-core.min.js', import.meta.url), 'utf8'), { filename: 'zip-core.min.js' });
vm.runInThisContext(await readFile(new URL('./cfb.min.js', import.meta.url), 'utf8'), { filename: 'cfb.min.js' });
vm.runInThisContext(await readFile(new URL('./format-capabilities.js', import.meta.url), 'utf8'), { filename: 'format-capabilities.js' });
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
const spreadsheetContentTypes = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
const spreadsheetRelationships = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const workbookXML = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>';

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

function doc({ wordDocument = true, validFIB = true, completeFIB = true, tableStream = true } = {}) {
  const container = CFB.utils.cfb_new();
  if (wordDocument) {
    const stream = new Uint8Array(1024);
    const view = new DataView(stream.buffer);
    view.setUint16(0, validFIB ? 0xa5ec : 0, true);
    view.setUint16(2, 0x00c1, true);
    if (completeFIB) {
      view.setUint16(10, 0x1000, true);
      view.setUint16(12, 0x00c1, true);
      view.setUint16(32, 0x000e, true);
      view.setUint16(62, 0x0016, true);
      view.setUint16(152, 0x005d, true);
      view.setUint16(898, 0, true);
    }
    CFB.utils.cfb_add(container, 'WordDocument', stream);
    if (tableStream) CFB.utils.cfb_add(container, '0Table', new Uint8Array(512));
  } else {
    CFB.utils.cfb_add(container, 'Workbook', new Uint8Array(512));
  }
  return Uint8Array.from(CFB.write(container, { type: 'buffer', fileType: 'cfb' }));
}

function record(type, body = new Uint8Array()) {
  const bytes = new Uint8Array(4 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, body.length, true);
  bytes.set(body, 4);
  return bytes;
}

function xls({ workbookStream = true, sheet = true } = {}) {
  const container = CFB.utils.cfb_new();
  if (workbookStream) {
    const bof = new Uint8Array(8);
    const view = new DataView(bof.buffer);
    view.setUint16(0, 0x0600, true);
    view.setUint16(2, 0x0005, true);
    view.setUint16(4, 0x2013, true);
    view.setUint16(6, 0x07cd, true);
    const records = [record(0x0809, bof)];
    if (sheet) records.push(record(0x0085, new Uint8Array(8)));
    records.push(record(0x000a));
    const stream = new Uint8Array(records.reduce((size, value) => size + value.length, 0));
    let offset = 0;
    for (const value of records) {
      stream.set(value, offset);
      offset += value.length;
    }
    CFB.utils.cfb_add(container, 'Workbook', stream);
  }
  return Uint8Array.from(CFB.write(container, { type: 'buffer', fileType: 'cfb' }));
}

async function xlsx(entries = {}) {
  const writer = new zip.ZipWriter(new zip.Uint8ArrayWriter());
  const files = {
    '[Content_Types].xml': spreadsheetContentTypes,
    '_rels/.rels': spreadsheetRelationships,
    'xl/workbook.xml': workbookXML,
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
function responseBody(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true };
        },
        async cancel() {}
      };
    }
  };
}
function sourceResponse(bytes = sourceBytes, overrides = {}) {
  return {
    ok: true,
    status: 200,
    type: 'basic',
    redirected: false,
    url: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
    headers: { get() { return String(bytes.byteLength); } },
    body: responseBody([bytes]),
    async arrayBuffer() { throw new Error('source body was not streamed'); },
    ...overrides
  };
}
globalThis.fetch = async (url, options) => {
  fetches.push({ url, options });
  const response = nextResponse || sourceResponse();
  nextResponse = undefined;
  return response;
};

vm.runInThisContext(await readFile(new URL('./source-identity-contract.js', import.meta.url), 'utf8'), { filename: 'source-identity-contract.js' });
vm.runInThisContext(await readFile(new URL('./source-identity.js', import.meta.url), 'utf8'), { filename: 'source-identity.js' });

assert.equal(
  RoadFlowSourceIdentityContract.sourcePath(
    'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03//%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A320260803_NHZP84.docx'
  ),
  '/Attachment/UploadFiles/202608/03//测试文档20260803_NHZP84.docx'
);
assert.equal(RoadFlowFormatCapabilities.forPath('/documents/Legacy.WPS').format, 'wps');
assert.equal(RoadFlowFormatCapabilities.forPath('/documents/Legacy.XLS').format, 'xls');
assert.equal(RoadFlowFormatCapabilities.forPath('/documents/Report.XLSX').format, 'xlsx');

const sourceURL = 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1';
const result = await RoadFlowSourceIdentity.derive(sourceURL, 'docx');
assert.deepEqual(result, {
  ok: true,
  identity: {
    sourcePath: '/documents/Quarterly Report.DOCX',
    actualFormat: 'docx',
    byteCount: sourceBytes.byteLength,
    sha256: createHash('sha256').update(sourceBytes).digest('hex')
  }
});
assert.deepEqual(fetches, [{
  url: sourceURL,
  options: { cache: 'no-store', credentials: 'include', redirect: 'manual' }
}]);

const nativeCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: {} });
nextResponse = sourceResponse(sourceBytes);
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Quarterly Report.DOCX',
    actualFormat: 'docx',
    byteCount: sourceBytes.byteLength,
    sha256: createHash('sha256').update(sourceBytes).digest('hex')
  }
});
Object.defineProperty(globalThis, 'crypto', { configurable: true, writable: true, value: nativeCrypto });

const nativeDecompressionStream = globalThis.DecompressionStream;
class UnsupportedRawDeflateStream {
  constructor(format) {
    if (format === 'deflate-raw') throw new TypeError('Unsupported compression format: deflate-raw');
  }
}
globalThis.DecompressionStream = UnsupportedRawDeflateStream;
zip.configure({ DecompressionStream: UnsupportedRawDeflateStream });
nextResponse = sourceResponse(sourceBytes);
assert.equal((await RoadFlowSourceIdentity.derive(sourceURL, 'docx')).ok, true);
globalThis.DecompressionStream = nativeDecompressionStream;
zip.configure({ DecompressionStream: nativeDecompressionStream });

const failure = { ok: false, message: 'Document verification failed. Editing was not opened.' };
const docURL = 'https://oa.example.test/documents/Legacy.DOC';
const docBytes = doc();
nextResponse = sourceResponse(docBytes, { url: docURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(docURL, 'doc'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Legacy.DOC',
    actualFormat: 'doc',
    byteCount: docBytes.byteLength,
    sha256: createHash('sha256').update(docBytes).digest('hex')
  }
});

// WPS saveURL_FormData can write a CFB Word document back to a .docx URL.
// The logical source path remains DOCX, but the saved serialization is still
// a valid editable Word document and must be accepted on the next open.
nextResponse = sourceResponse(docBytes, { url: sourceURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Quarterly Report.DOCX',
    actualFormat: 'docx',
    byteCount: docBytes.byteLength,
    sha256: createHash('sha256').update(docBytes).digest('hex')
  }
});

const wpsSavedWordBytes = new Uint8Array(await readFile(
  new URL('../roadflowsimulator/testdata/Acceptance.doc', import.meta.url)
));
nextResponse = sourceResponse(wpsSavedWordBytes, { url: sourceURL });
assert.equal((await RoadFlowSourceIdentity.derive(sourceURL, 'docx')).ok, true);

const wpsURL = 'https://oa.example.test/documents/Legacy.WPS';
const wpsBytes = doc();
nextResponse = sourceResponse(wpsBytes, { url: wpsURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(wpsURL, 'wps'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Legacy.WPS',
    actualFormat: 'wps',
    byteCount: wpsBytes.byteLength,
    sha256: createHash('sha256').update(wpsBytes).digest('hex')
  }
});

const xlsURL = 'https://oa.example.test/documents/Legacy.XLS';
const xlsBytes = xls();
nextResponse = sourceResponse(xlsBytes, { url: xlsURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(xlsURL, 'xls'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Legacy.XLS',
    actualFormat: 'xls',
    byteCount: xlsBytes.byteLength,
    sha256: createHash('sha256').update(xlsBytes).digest('hex')
  }
});

const xlsxURL = 'https://oa.example.test/documents/Report.XLSX';
const xlsxBytes = await xlsx();
nextResponse = sourceResponse(xlsxBytes, { url: xlsxURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(xlsxURL, 'xlsx'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Report.XLSX',
    actualFormat: 'xlsx',
    byteCount: xlsxBytes.byteLength,
    sha256: createHash('sha256').update(xlsxBytes).digest('hex')
  }
});

// WPS may return a legacy Excel CFB payload after saving an XLSX link.
nextResponse = sourceResponse(xlsBytes, { url: xlsxURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(xlsxURL, 'xlsx'), {
  ok: true,
  identity: {
    sourcePath: '/documents/Report.XLSX',
    actualFormat: 'xlsx',
    byteCount: xlsBytes.byteLength,
    sha256: createHash('sha256').update(xlsBytes).digest('hex')
  }
});

for (const [url, format, bytes] of [
  [wpsURL, 'wps', sourceBytes],
  [xlsURL, 'xls', doc()],
  [xlsxURL, 'xlsx', sourceBytes]
]) {
  nextResponse = sourceResponse(bytes, { url });
  assert.deepEqual(await RoadFlowSourceIdentity.derive(url, format), failure);
}

for (const invalidDOC of [
  doc({ wordDocument: false }),
  doc({ validFIB: false }),
  doc({ completeFIB: false }),
  doc({ tableStream: false }),
  sourceBytes
]) {
  nextResponse = sourceResponse(invalidDOC, { url: docURL });
  assert.deepEqual(await RoadFlowSourceIdentity.derive(docURL, 'doc'), failure);
}

nextResponse = sourceResponse(docBytes, {
  url: docURL,
  headers: { get() { return String(25 * 1024 * 1024 + 1); } },
  body: { getReader() { throw new Error('oversized DOC response body was read'); } }
});
assert.deepEqual(await RoadFlowSourceIdentity.derive(docURL, 'doc'), failure);

nextResponse = sourceResponse(docBytes, { url: docURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(docURL, 'docx'), failure);

nextResponse = sourceResponse(xlsBytes, { url: xlsURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(xlsURL, 'xlsx'), failure);

nextResponse = sourceResponse(xlsxBytes, { url: xlsxURL });
assert.deepEqual(await RoadFlowSourceIdentity.derive(xlsxURL, 'xls'), failure);

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

const fragmentURL = `${sourceURL}#section`;
nextResponse = sourceResponse(sourceBytes);
assert.equal((await RoadFlowSourceIdentity.derive(fragmentURL, 'docx')).ok, true);
assert.equal(fetches.at(-1).url, sourceURL);

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
  body: { getReader() { throw new Error('oversized response body was read'); } }
});
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

nextResponse = sourceResponse(sourceBytes, {
  headers: { get() { return '1'; } },
  body: responseBody([new Uint8Array(25 * 1024 * 1024 + 1)])
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

function corruptMember(bytes, filename) {
  const copy = Uint8Array.from(bytes);
  const view = new DataView(copy.buffer);
  const decoder = new TextDecoder();
  for (let offset = 0; offset <= copy.length - 30; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(copy.subarray(offset + 30, offset + 30 + nameLength));
    if (name === filename) {
      copy[offset + 30 + nameLength + extraLength] ^= 0xff;
      return copy;
    }
  }
  throw new Error(`ZIP member not found: ${filename}`);
}

const docxWithExtraMember = await docx({ 'custom/data.bin': 'checksum protected content' });
nextResponse = sourceResponse(corruptMember(docxWithExtraMember, 'custom/data.bin'));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

nextResponse = sourceResponse(await docx({ 'word/styles.xml': '<styles><malformed></styles>' }));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

nextResponse = sourceResponse(inflatedMetadata(sourceBytes, 1024 * 1024));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);

nextResponse = sourceResponse(inflatedMetadata(sourceBytes, 100 * 1024 * 1024 + 1));
assert.deepEqual(await RoadFlowSourceIdentity.derive(sourceURL, 'docx'), failure);
