import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let messageListener;
let localStored = {};
const extensionOrigin = 'chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd';
globalThis.chrome = {
  runtime: {
    getURL(path) { return `${extensionOrigin}/${path}`; },
    onMessage: { addListener(listener) { messageListener = listener; } }
  },
  storage: {
    local: {
      async get() { return localStored; },
      async set(update) { localStored = { ...localStored, ...update }; }
    }
  },
  permissions: {
    async contains({ origins }) {
      return [
        ['http://ywsh.yn.srrc.org.cn/*'],
        ['http://*/*', 'https://*/*']
      ].some(granted => JSON.stringify(origins) === JSON.stringify(granted));
    }
  }
};
globalThis.importScripts = async () => {};
globalThis.fetch = () => { throw new Error('Direct OA mode must not contact a Gateway.'); };
vm.runInThisContext(await readFile(new URL('./configuration.js', import.meta.url), 'utf8'), { filename: 'configuration.js' });
vm.runInThisContext(await readFile(new URL('./source-identity-contract.js', import.meta.url), 'utf8'), { filename: 'source-identity-contract.js' });
vm.runInThisContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), { filename: 'service-worker.js' });

const configuration = { trustedOrigin: 'http://ywsh.yn.srrc.org.cn' };
const response = await new Promise(resolve => {
  assert.equal(messageListener(
    { type: 'apply-configuration', configuration },
    { url: `${extensionOrigin}/options.html` },
    resolve
  ), true);
});
assert.deepEqual(response, { ok: true, configuration });
assert.deepEqual(localStored, { roadFlowIntegration: configuration });

const returnURL = 'http://ywsh.yn.srrc.org.cn/workflow/current?step=review';
const sourceURL = 'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03//%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A320260803_NHZP84.docx';
const sourcePath = '/Attachment/UploadFiles/202608/03//测试文档20260803_NHZP84.docx';
const sourceIdentity = {
  sourcePath,
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: 'a'.repeat(64)
};
const activation = { returnURL, sourceURL, title: '测试文档20260803_NHZP84.docx', sourceIdentity };

const configurationResponse = await new Promise(resolve => {
  messageListener({ type: 'configuration' }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.deepEqual(configurationResponse, { ok: true, configuration });

const created = await new Promise(resolve => {
  messageListener({ type: 'create-editor-handoff', activation }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.equal(created.ok, true);
assert.match(created.editorLaunch.handoff, /^[a-f0-9]{64}$/);
const launchedDocumentURL = new URL(created.editorLaunch.documentURL);
assert.equal(`${launchedDocumentURL.origin}${launchedDocumentURL.pathname}`, sourceURL);
assert.match(launchedDocumentURL.hash, /^#roadflow-handoff=[a-f0-9]{64}$/);
assert.equal(created.editorLaunch.sourcePath, sourcePath);
assert.equal(created.editorLaunch.sourceIdentity.sourcePath, sourcePath);
assert.equal(created.editorLaunch.returnURL, returnURL);
assert.equal(
  new URL(created.editorLaunch.officeSaveURL).pathname,
  '/RoadFlow/uploadfiles/OfficeSave'
);
assert.equal(new URL(created.editorLaunch.officeSaveURL).searchParams.get('fileurl'), sourcePath);
assert.equal('receiptURL' in created.editorLaunch, false);
assert.equal('gatewayTemplate' in created.editorLaunch, false);

for (const invalid of [
  { activation: { ...activation, sourceIdentity: undefined }, senderURL: returnURL },
  { activation: { ...activation, sourceIdentity: { ...sourceIdentity, sourcePath: '/wrong.docx' } }, senderURL: returnURL },
  { activation: { ...activation, sourceURL: 'http://files.example.test/report.docx' }, senderURL: returnURL },
  { activation: { ...activation, sourceURL: 'http://ywsh.yn.srrc.org.cn/report.xlsx' }, senderURL: returnURL },
  { activation, senderURL: 'http://ywsh.yn.srrc.org.cn/other-page' }
]) {
  const rejected = await new Promise(resolve => {
    messageListener(
      { type: 'create-editor-handoff', activation: invalid.activation },
      { url: invalid.senderURL, tab: { id: 7 } },
      resolve
    );
  });
  assert.deepEqual(rejected, { ok: false });
}

const allOriginsConfiguration = { trustedOrigin: '' };
const allOriginsResponse = await new Promise(resolve => {
  assert.equal(messageListener(
    { type: 'apply-configuration', configuration: allOriginsConfiguration },
    { url: `${extensionOrigin}/options.html` },
    resolve
  ), true);
});
assert.deepEqual(allOriginsResponse, { ok: true, configuration: allOriginsConfiguration });
assert.deepEqual(localStored, { roadFlowIntegration: allOriginsConfiguration });

const externalReturnURL = 'http://other-oa.example.test/workflow/current';
const externalSourceURL = 'https://files.example.test/documents/External.DOCX';
const externalSourcePath = '/documents/External.DOCX';
const externalActivation = {
  returnURL: externalReturnURL,
  sourceURL: externalSourceURL,
  title: 'External Document',
  sourceIdentity: {
    sourcePath: externalSourcePath,
    actualFormat: 'docx',
    byteCount: 4096,
    sha256: 'b'.repeat(64)
  }
};
const allOriginsConfigurationResponse = await new Promise(resolve => {
  messageListener({ type: 'configuration' }, { url: externalReturnURL, tab: { id: 8 } }, resolve);
});
assert.deepEqual(allOriginsConfigurationResponse, { ok: true, configuration: allOriginsConfiguration });
const externalCreated = await new Promise(resolve => {
  messageListener({ type: 'create-editor-handoff', activation: externalActivation }, {
    url: externalReturnURL,
    tab: { id: 8 }
  }, resolve);
});
assert.equal(externalCreated.ok, true);
assert.equal(new URL(externalCreated.editorLaunch.officeSaveURL).origin, 'http://other-oa.example.test');
assert.equal(new URL(externalCreated.editorLaunch.officeSaveURL).searchParams.get('fileurl'), externalSourcePath);

const unauthorizedConfiguration = await new Promise(resolve => {
  messageListener(
    { type: 'apply-configuration', configuration },
    { url: returnURL },
    resolve
  );
});
assert.deepEqual(unauthorizedConfiguration, {
  ok: false,
  message: 'Configuration request was not authorized.'
});
