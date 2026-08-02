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
  activeDocument = true,
  overwriteResults = [true],
  confirmDiscard = true,
  replaceError
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
  const overwriteCalls = [];
  const fetches = [];
  const confirmations = [];
  const windowListeners = {};
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
      const expectedIdentity = consumeResponse?.handoff?.sourceIdentity || sourceIdentity;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            handoff: receiptHandoff,
            sourcePath: expectedIdentity.sourcePath,
            actualFormat: expectedIdentity.actualFormat,
            byteCount: expectedIdentity.byteCount,
            sha256: receiptMode === 'mismatch' ? 'f'.repeat(64) : expectedIdentity.sha256,
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
            ActiveDocument: activeDocument ? {
              saveURL_FormData(url, metadata) {
                overwriteCalls.push({ url, metadata });
                const result = overwriteResults[Math.min(overwriteCalls.length - 1, overwriteResults.length - 1)];
                if (result instanceof Error) throw result;
                return result;
              }
            } : undefined,
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
      replace(url) {
        if (replaceError) throw replaceError;
        replacementURL = url;
      }
    },
    confirm(message) {
      confirmations.push(message);
      return confirmDiscard;
    },
    addEventListener(type, listener) {
      windowListeners[type] = listener;
    }
  });
  vm.runInContext(identityContract, context, { filename: 'source-identity-contract.js' });
  vm.runInContext(gateContract, context, { filename: 'identity-gate.js' });
  vm.runInContext(script, context, { filename: 'editor.js' });
  await settle(receiptMode === 'missing' ? 80 : 20);
  return {
    elements, messages, documentOpens, overwriteCalls, fetches, confirmations, windowListeners,
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
  url: `https://gateway.example.test/wps/v1/document?fileurl=%2Fdocuments%2FQuarterly%2520Report.DOCX&_wpsHandoff=${firstHandoffID}`,
  readOnly: false
}]);
assert.deepEqual(JSON.parse(JSON.stringify(verified.fetches)), [{
  url: `https://gateway.example.test/wps/v1/delivery-receipt?handoff=${firstHandoffID}`,
  options: { cache: 'no-store', credentials: 'omit' }
}]);

const overwriting = await loadEditor();
const overwritePromise = overwriting.elements['save-document'].clickListener();
const duplicateOverwrite = overwriting.elements['save-document'].clickListener();
assert.equal(overwriting.elements['save-document'].disabled, true);
assert.equal(overwriting.elements['return-to-oa'].disabled, true);
assert.equal(overwriting.elements['editor-status'].textContent, '正在保存');
const unloadEvent = {
  defaultPrevented: false,
  returnValue: undefined,
  preventDefault() { this.defaultPrevented = true; }
};
overwriting.windowListeners.beforeunload(unloadEvent);
assert.equal(unloadEvent.defaultPrevented, true);
assert.equal(unloadEvent.returnValue, '');
await overwritePromise;
await duplicateOverwrite;
assert.deepEqual(overwriting.overwriteCalls, [{
  url: 'https://oa.example.test/RoadFlow/uploadfiles/OfficeSave?fileurl=%2Fdocuments%2FQuarterly%2520Report.DOCX',
  metadata: 'formId:formeditor'
}]);
assert.equal(overwriting.elements['editor-status'].textContent, '已保存');
assert.equal(overwriting.elements['save-document'].textContent, '保存');
assert.equal(overwriting.elements['save-document'].disabled, false);
assert.equal(overwriting.elements['return-to-oa'].disabled, false);
assert.equal(overwriting.overwriteCalls.length, 1);
overwriting.elements['return-to-oa'].clickListener();
assert.equal(overwriting.replacementURL(), handoff.returnURL);

const recoverableFailure = await loadEditor({ overwriteResults: [false, true], confirmDiscard: false });
const liveWPS = recoverableFailure.elements['editor-host'].children[0];
await recoverableFailure.elements['save-document'].clickListener();
assert.equal(recoverableFailure.elements['editor-host'].children.length, 1);
assert.equal(recoverableFailure.elements['editor-host'].children[0], liveWPS);
assert.equal(recoverableFailure.elements['editor-host'].className, 'unlocked');
assert.equal(recoverableFailure.elements['editor-status'].textContent, '保存失败');
assert.equal(recoverableFailure.elements['save-document'].textContent, '重试保存');
assert.equal(recoverableFailure.elements['save-document'].disabled, false);
assert.equal(recoverableFailure.elements['return-to-oa'].disabled, false);
assert.equal(recoverableFailure.overwriteCalls.length, 1);
recoverableFailure.elements['return-to-oa'].clickListener();
assert.deepEqual(recoverableFailure.confirmations, ['保存失败。放弃当前修改并返回 OA？']);
assert.equal(recoverableFailure.replacementURL(), undefined);
assert.equal(recoverableFailure.elements['editor-host'].children[0], liveWPS);
assert.equal(recoverableFailure.elements['save-document'].disabled, false);
assert.equal(recoverableFailure.elements['return-to-oa'].disabled, false);
await recoverableFailure.elements['save-document'].clickListener();
assert.equal(recoverableFailure.overwriteCalls.length, 2);
assert.deepEqual(recoverableFailure.overwriteCalls[1], recoverableFailure.overwriteCalls[0]);
assert.equal(recoverableFailure.elements['editor-status'].textContent, '已保存');
assert.equal(recoverableFailure.replacementURL(), undefined);

const discarded = await loadEditor({ overwriteResults: [new Error('OA rejected overwrite')] });
const discardedWPS = discarded.elements['editor-host'].children[0];
await discarded.elements['save-document'].clickListener();
assert.equal(discarded.elements['editor-host'].children[0], discardedWPS);
assert.equal(discarded.elements['editor-status'].textContent, '保存失败');
assert.equal(discarded.elements['save-document'].textContent, '重试保存');
assert.equal(discarded.overwriteCalls.length, 1);
discarded.elements['return-to-oa'].clickListener();
assert.deepEqual(discarded.confirmations, ['保存失败。放弃当前修改并返回 OA？']);
assert.equal(discarded.replacementURL(), handoff.returnURL);

const navigationFailure = await loadEditor({ replaceError: new Error('navigation blocked') });
navigationFailure.elements['return-to-oa'].clickListener();
assert.equal(navigationFailure.elements['editor-host'].children.length, 1);
assert.equal(navigationFailure.elements['editor-host'].className, 'unlocked');
assert.equal(navigationFailure.elements['return-to-oa'].disabled, false);
assert.equal(navigationFailure.elements['editor-status'].textContent, '返回 OA 失败');

const returnFailureAfterRecoverableOverwriteFailure = await loadEditor({
  overwriteResults: [false, true],
  replaceError: new Error('navigation blocked')
});
const failedReturnWPS = returnFailureAfterRecoverableOverwriteFailure.elements['editor-host'].children[0];
await returnFailureAfterRecoverableOverwriteFailure.elements['save-document'].clickListener();
returnFailureAfterRecoverableOverwriteFailure.elements['return-to-oa'].clickListener();
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['editor-host'].children[0], failedReturnWPS);
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['editor-host'].className, 'unlocked');
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['editor-status'].textContent, '返回 OA 失败');
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['save-document'].textContent, '重试保存');
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['save-document'].disabled, false);
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['return-to-oa'].disabled, false);
await returnFailureAfterRecoverableOverwriteFailure.elements['save-document'].clickListener();
assert.equal(returnFailureAfterRecoverableOverwriteFailure.overwriteCalls.length, 2);
assert.deepEqual(returnFailureAfterRecoverableOverwriteFailure.overwriteCalls[1],
  returnFailureAfterRecoverableOverwriteFailure.overwriteCalls[0]);
assert.equal(returnFailureAfterRecoverableOverwriteFailure.elements['editor-status'].textContent, '已保存');

const freshHandoffID = 'b'.repeat(64);
const committedIdentity = { ...sourceIdentity, sha256: 'c'.repeat(64), byteCount: 8192 };
const reopened = await loadEditor({
  search: `?handoff=${freshHandoffID}`,
  consumeResponse: { ok: true, handoff: { ...handoff, sourceIdentity: committedIdentity } }
});
assert.deepEqual(JSON.parse(JSON.stringify(reopened.messages)), [
  { type: 'consume-editor-handoff', handoffID: freshHandoffID }
]);
assert.match(reopened.documentOpens[0].url, new RegExp(`_wpsHandoff=${freshHandoffID}$`));
assert.equal(reopened.elements['editor-host'].className, 'unlocked');
assert.equal(reopened.elements['editor-status'].textContent, '正文可编辑');

const legacyDOCIdentity = {
  sourcePath: '/documents/Legacy.DOC',
  actualFormat: 'doc',
  byteCount: 3072,
  sha256: 'd'.repeat(64)
};
const legacyDOC = await loadEditor({
  consumeResponse: {
    ok: true,
    handoff: {
      ...handoff,
      sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
      sourcePath: legacyDOCIdentity.sourcePath,
      filename: 'Legacy.DOC',
      expectedFormat: 'doc',
      sourceIdentity: legacyDOCIdentity
    }
  }
});
assert.equal(legacyDOC.elements['editor-host'].className, 'unlocked');
assert.equal(legacyDOC.elements['save-document'].disabled, false);
assert.deepEqual(legacyDOC.documentOpens, [{
  url: `https://gateway.example.test/wps/v1/document?fileurl=%2Fdocuments%2FLegacy.DOC&_wpsHandoff=${firstHandoffID}`,
  readOnly: false
}]);
await legacyDOC.elements['save-document'].clickListener();
assert.deepEqual(legacyDOC.overwriteCalls, [{
  url: 'https://oa.example.test/RoadFlow/uploadfiles/OfficeSave?fileurl=%2Fdocuments%2FLegacy.DOC',
  metadata: 'formId:formeditor'
}]);
legacyDOC.elements['return-to-oa'].clickListener();
assert.equal(legacyDOC.replacementURL(), handoff.returnURL);

const freshDOCHandoffID = '9'.repeat(64);
const committedDOCIdentity = { ...legacyDOCIdentity, byteCount: 3584, sha256: '9'.repeat(64) };
const reopenedLegacyDOC = await loadEditor({
  search: `?handoff=${freshDOCHandoffID}`,
  consumeResponse: {
    ok: true,
    handoff: {
      ...handoff,
      sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
      sourcePath: committedDOCIdentity.sourcePath,
      filename: 'Legacy.DOC',
      expectedFormat: 'doc',
      sourceIdentity: committedDOCIdentity
    }
  }
});
assert.equal(reopenedLegacyDOC.elements['editor-host'].className, 'unlocked');
assert.match(reopenedLegacyDOC.documentOpens[0].url, new RegExp(`_wpsHandoff=${freshDOCHandoffID}$`));
assert.equal(reopenedLegacyDOC.elements['editor-status'].textContent, '正文可编辑');

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
