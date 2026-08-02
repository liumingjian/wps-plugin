import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./editor.html', import.meta.url), 'utf8');
const identityContract = await readFile(new URL('./source-identity-contract.js', import.meta.url), 'utf8');
const gateContract = await readFile(new URL('./identity-gate.js', import.meta.url), 'utf8');
const script = await readFile(new URL('./editor.js', import.meta.url), 'utf8');
assert.doesNotMatch(html, /<object\b|application\/x-wps/i);
assert.deepEqual([...html.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map(match => match[1]), [
  'retry-verification', 'save-document', 'return-to-oa'
]);
assert.match(html, /source-identity-contract\.js[\s\S]*identity-gate\.js[\s\S]*editor\.js/);

const firstHandoffID = 'a'.repeat(64);
const sourceIdentity = {
  sourcePath: '/documents/Quarterly%20Report.DOCX',
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: 'e'.repeat(64)
};
const handoff = {
  returnURL: 'https://oa.example.test/workflow/current?step=review#document',
  trustedOrigin: 'https://oa.example.test',
  sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
  sourcePath: sourceIdentity.sourcePath,
  title: 'Quarterly Report',
  filename: 'Quarterly Report.DOCX',
  expectedFormat: 'docx',
  gatewayTemplate: 'https://gateway.example.test/wps/v1/document?fileurl={sourcePath}',
  sourceIdentity,
  cacheIdentity: 'b'.repeat(32),
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000
};

async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) await new Promise(resolve => setImmediate(resolve));
}

async function loadEditor({
  search = `?handoff=${firstHandoffID}`,
  consumeResponse = { ok: true, handoff },
  openResults = [true],
  receiptMode = 'match',
  activeDocument = true
} = {}) {
  const elements = Object.fromEntries([
    'document-title', 'source-label', 'editor-status', 'editor-host',
    'retry-verification', 'save-document', 'return-to-oa'
  ].map(id => [id, {
    textContent: '',
    disabled: id !== 'retry-verification',
    hidden: id === 'retry-verification',
    className: '',
    children: [],
    replaceChildren(...children) { this.children = children; },
    append(child) { this.children.push(child); },
    addEventListener(type, listener) { this[`${type}Listener`] = listener; }
  }]));
  const messages = [];
  const documentOpens = [];
  const fetches = [];
  let replacementURL;
  let now = 1_800_000_001_000;
  let objectCount = 0;
  class FakeDate extends Date { static now() { return now; } }

  const context = vm.createContext({
    Date: FakeDate,
    URL,
    URLSearchParams,
    Promise,
    setTimeout(resolve, milliseconds) { now += milliseconds; queueMicrotask(resolve); },
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          if (message.type === 'consume-editor-handoff') return consumeResponse;
          if (message.type === 'create-reverification-handoff') {
            return { ok: true, returnURL: handoff.returnURL };
          }
          throw new Error(`Unexpected message ${message.type}`);
        }
      }
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      if (receiptMode === 'missing') return { ok: false, status: 404 };
      if (receiptMode === 'conflict') return { ok: false, status: 409 };
      const receiptHandoff = new URL(url).searchParams.get('handoff');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            handoff: receiptHandoff,
            sourcePath: sourceIdentity.sourcePath,
            actualFormat: sourceIdentity.actualFormat,
            byteCount: sourceIdentity.byteCount,
            sha256: receiptMode === 'mismatch' ? 'f'.repeat(64) : sourceIdentity.sha256,
            deliveredAt: new FakeDate(now).toISOString()
          };
        }
      };
    },
    document: {
      querySelector(selector) { return elements[selector.slice(1)]; },
      createElement(tagName) {
        if (tagName === 'param') return { tagName, name: '', value: '' };
        const openResult = openResults[Math.min(objectCount, openResults.length - 1)];
        objectCount += 1;
        return {
          tagName,
          id: '',
          name: '',
          type: '',
          ariaLabel: '',
          children: [],
          append(child) { this.children.push(child); },
          Application: {
            ActiveDocument: activeDocument ? {} : undefined,
            openDocument(url, readOnly) {
              documentOpens.push({ url, readOnly });
              return openResult;
            }
          }
        };
      }
    },
    location: {
      search,
      replace(url) { replacementURL = url; }
    }
  });
  vm.runInContext(identityContract, context, { filename: 'source-identity-contract.js' });
  vm.runInContext(gateContract, context, { filename: 'identity-gate.js' });
  vm.runInContext(script, context, { filename: 'editor.js' });
  await settle(receiptMode === 'missing' ? 80 : 20);
  return {
    elements, messages, documentOpens, fetches,
    replacementURL: () => replacementURL
  };
}

const verified = await loadEditor();
assert.deepEqual(JSON.parse(JSON.stringify(verified.messages)), [
  { type: 'consume-editor-handoff', handoffID: firstHandoffID }
]);
assert.equal(verified.elements['editor-host'].children.length, 1);
assert.equal(verified.elements['editor-host'].children[0].type, 'application/x-wps');
assert.equal(verified.elements['editor-host'].className, 'unlocked');
assert.equal(verified.elements['save-document'].disabled, false);
assert.equal(verified.elements['return-to-oa'].disabled, false);
assert.equal(verified.elements['retry-verification'].hidden, true);
assert.equal(verified.elements['editor-status'].textContent, '正文可编辑');
assert.deepEqual(verified.documentOpens, [{
  url: 'https://gateway.example.test/wps/v1/document?fileurl=%2Fdocuments%2FQuarterly%2520Report.DOCX&_wpsHandoff=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  readOnly: false
}]);
assert.deepEqual(JSON.parse(JSON.stringify(verified.fetches)), [{
  url: `https://gateway.example.test/wps/v1/delivery-receipt?handoff=${firstHandoffID}`,
  options: { cache: 'no-store', credentials: 'omit' }
}]);
verified.elements['return-to-oa'].clickListener();
assert.equal(verified.replacementURL(), handoff.returnURL);

for (const failure of [
  { openResults: [false], receiptMode: 'match' },
  { openResults: [1], receiptMode: 'match' },
  { openResults: [true], activeDocument: false, receiptMode: 'match' },
  { openResults: [true], receiptMode: 'mismatch' },
  { openResults: [true], receiptMode: 'conflict' },
  { openResults: [true], receiptMode: 'missing' }
]) {
  const rejected = await loadEditor(failure);
  assert.equal(rejected.elements['editor-host'].children.length, 0);
  assert.equal(rejected.elements['save-document'].disabled, true);
  assert.equal(rejected.elements['retry-verification'].hidden, false);
  assert.equal(rejected.elements['return-to-oa'].disabled, false);
  assert.match(rejected.elements['editor-status'].textContent, /验证失败/);
  assert.equal(rejected.fetches.some(({ url }) => /OfficeSave|upload|overwrite/i.test(url)), false);
}

const retried = await loadEditor({ openResults: [false] });
await retried.elements['retry-verification'].clickListener();
await settle(20);
assert.deepEqual(retried.messages.slice(1).map(message => message.type), ['create-reverification-handoff']);
assert.equal(retried.elements['editor-host'].children.length, 0);
assert.equal(retried.elements['save-document'].disabled, true);
assert.equal(retried.replacementURL(), handoff.returnURL);

for (const [search, response] of [
  ['', undefined],
  ['?handoff=../report.docx', undefined],
  [`?handoff=${firstHandoffID}`, { ok: false }],
  [`?handoff=${firstHandoffID}`, { ok: true, handoff: {} }]
]) {
  const unavailable = await loadEditor({ search, consumeResponse: response });
  assert.equal(unavailable.elements['editor-host'].children.length, 0);
  assert.match(unavailable.elements['editor-status'].textContent, /cannot be opened/i);
}
