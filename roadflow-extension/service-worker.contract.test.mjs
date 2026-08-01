import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let messageListener;
let localStored = {};
let sessionStored = {};
let now = 1_800_000_000_000;
const extensionOrigin = 'chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return now; }
};

globalThis.chrome = {
  runtime: {
    getURL(path) { return `${extensionOrigin}/${path}`; },
    onMessage: { addListener(listener) { messageListener = listener; } }
  },
  storage: {
    local: {
      async get() { return localStored; },
      async set(update) { localStored = { ...localStored, ...update }; }
    },
    session: {
      async get() { return sessionStored; },
      async set(update) { sessionStored = { ...sessionStored, ...update }; }
    }
  },
  permissions: {
    async contains({ origins }) { return origins[0] === 'https://oa.example.test/*'; }
  }
};
globalThis.importScripts = async () => {};
vm.runInThisContext(await readFile(new URL('./configuration.js', import.meta.url), 'utf8'), { filename: 'configuration.js' });
vm.runInThisContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), { filename: 'service-worker.js' });

const configuration = {
  trustedOrigin: 'https://oa.example.test',
  gatewayTemplate: 'https://gateway.example.test/wps?fileurl={sourcePath}'
};
const response = await new Promise(resolve => {
  assert.equal(messageListener(
    { type: 'apply-configuration', configuration },
    { url: `${extensionOrigin}/options.html` },
    resolve
  ), true);
});
assert.deepEqual(response, { ok: true, configuration });
assert.deepEqual(localStored, { roadFlowIntegration: configuration });

const rejected = await new Promise(resolve => {
  messageListener(
    { type: 'apply-configuration', configuration },
    { url: 'https://oa.example.test/settings' },
    resolve
  );
});
assert.deepEqual(rejected, { ok: false, message: 'Configuration request was not authorized.' });

const returnURL = 'https://oa.example.test/workflow/current?step=review#document';
const activation = {
  returnURL,
  sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
  title: 'Quarterly Report',
  sourceIdentity: {
    sourcePath: '/documents/Quarterly%20Report.DOCX',
    actualFormat: 'docx',
    byteCount: 4096,
    sha256: 'a'.repeat(64)
  }
};
const configurationResponse = await new Promise(resolve => {
  messageListener({ type: 'configuration' }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.deepEqual(configurationResponse, { ok: true, configuration });

async function createHandoff() {
  return new Promise(resolve => {
    messageListener({ type: 'create-editor-handoff', activation }, { url: returnURL, tab: { id: 7 } }, resolve);
  });
}

const created = await createHandoff();
assert.equal(created.ok, true);
const editorURL = new URL(created.editorURL);
assert.equal(`${editorURL.protocol}//${editorURL.host}`, extensionOrigin);
assert.equal(editorURL.pathname, '/editor.html');
assert.deepEqual([...editorURL.searchParams.keys()], ['handoff']);
assert.match(editorURL.searchParams.get('handoff'), /^[a-f0-9]{64}$/);
assert.doesNotMatch(created.editorURL, /oa\.example|documents|Quarterly/i);

const consume = () => new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: editorURL.searchParams.get('handoff') },
    { url: created.editorURL },
    resolve
  );
});
const consumedResults = await Promise.all([consume(), consume()]);
const successful = consumedResults.filter(result => result.ok);
assert.equal(successful.length, 1);
assert.deepEqual(successful[0].handoff, {
  returnURL,
  trustedOrigin: 'https://oa.example.test',
  sourceURL: activation.sourceURL,
  sourcePath: '/documents/Quarterly%20Report.DOCX',
  title: 'Quarterly Report',
  filename: 'Quarterly Report.DOCX',
  expectedFormat: 'docx',
  sourceIdentity: activation.sourceIdentity,
  cacheIdentity: successful[0].handoff.cacheIdentity,
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000
});
assert.match(successful[0].handoff.cacheIdentity, /^[a-f0-9]{32}$/);
assert.deepEqual(await consume(), { ok: false });

for (const sourceIdentity of [
  undefined,
  { ...activation.sourceIdentity, sourcePath: '/documents/Another.docx' },
  { ...activation.sourceIdentity, actualFormat: 'doc' },
  { ...activation.sourceIdentity, byteCount: 0 },
  { ...activation.sourceIdentity, sha256: 'not-a-digest' }
]) {
  const rejectedIdentity = await new Promise(resolve => {
    messageListener(
      { type: 'create-editor-handoff', activation: { ...activation, sourceIdentity } },
      { url: returnURL, tab: { id: 7 } },
      resolve
    );
  });
  assert.deepEqual(rejectedIdentity, { ok: false });
}

const malformed = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: '../Quarterly Report.docx' },
    { url: `${extensionOrigin}/editor.html?handoff=../Quarterly%20Report.docx` },
    resolve
  );
});
assert.deepEqual(malformed, { ok: false });

const senderProtected = await createHandoff();
const senderProtectedID = new URL(senderProtected.editorURL).searchParams.get('handoff');
const wrongSender = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: senderProtectedID },
    { url: `file:///editor.html?handoff=${senderProtectedID}` },
    resolve
  );
});
assert.deepEqual(wrongSender, { ok: false });
const rightSender = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: senderProtectedID },
    { url: senderProtected.editorURL },
    resolve
  );
});
assert.equal(rightSender.ok, true);

const expiring = await createHandoff();
now += 120_001;
const expired = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: new URL(expiring.editorURL).searchParams.get('handoff') },
    { url: expiring.editorURL },
    resolve
  );
});
assert.deepEqual(expired, { ok: false });
