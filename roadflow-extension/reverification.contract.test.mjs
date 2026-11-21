import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const handoffID = 'd'.repeat(64);
const sourceURL = 'https://oa.example.test/documents/Legacy.DOC?download=1';
const identity = {
  sourcePath: '/documents/Legacy.DOC',
  actualFormat: 'doc',
  byteCount: 3072,
  sha256: 'e'.repeat(64)
};
const editorURL = `chrome-extension://fixed/editor.html?handoff=${handoffID}`;
for (const outcome of ['success', 'failure', 'exception', 'timeout']) {
const messages = [];
const sourceReads = [];
let replacementURL;

const context = vm.createContext({
  URL,
  setTimeout: outcome === 'timeout' ? callback => { queueMicrotask(callback); return 1; } : setTimeout,
  clearTimeout: outcome === 'timeout' ? () => {} : clearTimeout,
  RoadFlowSourceIdentity: {
    async derive(url, expectedFormat) {
      sourceReads.push({ url, expectedFormat });
      if (outcome === 'timeout') return new Promise(() => {});
      if (outcome === 'exception') throw new Error('Source read failed');
      return outcome === 'success' ? { ok: true, identity } : { ok: false };
    }
  },
  chrome: {
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'configuration') {
          return { ok: true, configuration: { trustedOrigin: 'https://oa.example.test' } };
        }
        if (message.type === 'claim-reverification') return { ok: true, handoffID, sourceURL, expectedFormat: 'doc' };
        if (message.type === 'complete-reverification-handoff') return { ok: true, editorURL };
        throw new Error(`Unexpected message ${message.type}`);
      }
    },
    storage: { onChanged: { addListener() {} } }
  },
  window: { addEventListener() {}, alert() { throw new Error('Unexpected alert'); } },
  location: {
    href: 'https://oa.example.test/workflow/current?step=review#document',
    origin: 'https://oa.example.test',
    replace(url) { replacementURL = url; }
  }
});

vm.runInContext(await readFile(new URL('./content.js', import.meta.url), 'utf8'), context, {
  filename: 'content.js'
});
for (let turn = 0; turn < 10; turn += 1) await new Promise(resolve => setImmediate(resolve));

assert.deepEqual(sourceReads, [{ url: sourceURL, expectedFormat: 'doc' }]);
assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
  { type: 'configuration' },
  { type: 'claim-reverification' },
  { type: 'complete-reverification-handoff', handoffID,
    ...(outcome === 'success' ? { sourceIdentity: identity } : { sourceVerificationFailed: true }) }
]);
assert.equal(replacementURL, editorURL);

}
