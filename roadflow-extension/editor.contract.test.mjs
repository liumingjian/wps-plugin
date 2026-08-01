import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('./editor.html', import.meta.url), 'utf8');
const identityContract = await readFile(new URL('./source-identity-contract.js', import.meta.url), 'utf8');
const script = await readFile(new URL('./editor.js', import.meta.url), 'utf8');
assert.doesNotMatch(html, /<object\b|application\/x-wps/i);
assert.match(html, /<script src="editor\.js"><\/script>/);
assert.match(html, /<script src="source-identity-contract\.js"><\/script>\s*<script src="editor\.js"><\/script>/);

const handoffID = 'a'.repeat(64);
const handoff = {
  returnURL: 'https://oa.example.test/workflow/current?step=review#document',
  trustedOrigin: 'https://oa.example.test',
  sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
  sourcePath: '/documents/Quarterly%20Report.DOCX',
  title: 'Quarterly Report',
  filename: 'Quarterly Report.DOCX',
  expectedFormat: 'docx',
  sourceIdentity: {
    sourcePath: '/documents/Quarterly%20Report.DOCX',
    actualFormat: 'docx',
    byteCount: 4096,
    sha256: 'a'.repeat(64)
  },
  cacheIdentity: 'b'.repeat(32),
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000
};

async function loadEditor(search, consumeResponse) {
  const elements = Object.fromEntries([
    'document-title', 'source-label', 'editor-status', 'editor-host', 'return-to-oa'
  ].map(id => [id, {
    textContent: '',
    disabled: true,
    hidden: false,
    children: [],
    append(child) { this.children.push(child); },
    addEventListener(type, listener) { this[`${type}Listener`] = listener; }
  }]));
  const messages = [];
  const createdElements = [];
  let replacementURL;
  const context = vm.createContext({
    Date,
    URL,
    URLSearchParams,
    chrome: {
      runtime: {
        async sendMessage(message) {
          messages.push(message);
          return consumeResponse;
        }
      }
    },
    document: {
      querySelector(selector) { return elements[selector.slice(1)]; },
      createElement(tagName) {
        const element = { tagName, id: '', type: '', ariaLabel: '' };
        createdElements.push(element);
        return element;
      }
    },
    location: {
      search,
      replace(url) { replacementURL = url; }
    }
  });
  vm.runInContext(identityContract, context, { filename: 'source-identity-contract.js' });
  vm.runInContext(script, context, { filename: 'editor.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { createdElements, elements, messages, replacementURL: () => replacementURL };
}

const valid = await loadEditor(`?handoff=${handoffID}`, { ok: true, handoff });
assert.deepEqual(JSON.parse(JSON.stringify(valid.messages)), [{ type: 'consume-editor-handoff', handoffID }]);
assert.deepEqual(valid.createdElements, [{
  tagName: 'object',
  id: 'wps-surface',
  type: 'application/x-wps',
  ariaLabel: 'WPS Document editor'
}]);
assert.equal(valid.elements['document-title'].textContent, 'Quarterly Report');
assert.equal(valid.elements['source-label'].textContent, '/documents/Quarterly%20Report.DOCX');
assert.equal(valid.elements['return-to-oa'].disabled, false);
valid.elements['return-to-oa'].clickListener();
assert.equal(valid.replacementURL(), handoff.returnURL);

const legacyDoc = await loadEditor(`?handoff=${handoffID}`, {
  ok: true,
  handoff: {
    ...handoff,
    sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
    sourcePath: '/documents/Legacy.DOC',
    filename: 'Legacy.DOC',
    expectedFormat: 'doc',
    sourceIdentity: undefined
  }
});
assert.equal(legacyDoc.createdElements.length, 1);

for (const [search, response, expectedMessages] of [
  ['', undefined, []],
  ['?handoff=../report.docx', undefined, []],
  [`?handoff=${handoffID}`, { ok: false }, [{ type: 'consume-editor-handoff', handoffID }]],
  [`?handoff=${handoffID}`, { ok: true, handoff: {} }, [{ type: 'consume-editor-handoff', handoffID }]],
  [`?handoff=${handoffID}`, {
    ok: true,
    handoff: { ...handoff, sourcePath: '/documents/Another%20Report.DOCX' }
  }, [{ type: 'consume-editor-handoff', handoffID }]],
  [`?handoff=${handoffID}`, {
    ok: true,
    handoff: { ...handoff, sourceIdentity: { ...handoff.sourceIdentity, sha256: 'invalid' } }
  }, [{ type: 'consume-editor-handoff', handoffID }]]
]) {
  const rejected = await loadEditor(search, response);
  assert.deepEqual(JSON.parse(JSON.stringify(rejected.messages)), expectedMessages);
  assert.equal(rejected.createdElements.length, 0);
  assert.equal(rejected.elements['return-to-oa'].disabled, true);
  assert.match(rejected.elements['editor-status'].textContent, /cannot be opened/i);
}
