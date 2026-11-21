import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let messageListener;
let tabRemovedListener;
let localStored = {};
let sessionStored = {};
let now = 1_800_000_000_000;
const extensionOrigin = 'chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd';
const RealDate = Date;
globalThis.Date = class extends RealDate {
  static now() { return now; }
};

globalThis.chrome = {
  tabs: { onRemoved: { addListener(listener) { tabRemovedListener = listener; } } },
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
    async contains({ origins }) {
      return JSON.stringify(origins) === JSON.stringify([
        'https://oa.example.test/*', 'https://gateway.example.test/*'
      ]);
    }
  }
};
globalThis.importScripts = async () => {};
vm.runInThisContext(await readFile(new URL('./configuration.js', import.meta.url), 'utf8'), { filename: 'configuration.js' });
vm.runInThisContext(await readFile(new URL('./source-identity-contract.js', import.meta.url), 'utf8'), { filename: 'source-identity-contract.js' });
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
    { url: created.editorURL, tab: { id: 7 } },
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
  gatewayTemplate: configuration.gatewayTemplate,
  sourceIdentity: activation.sourceIdentity,
  createdAt: 1_800_000_000_000,
  expiresAt: 1_800_000_120_000
});
assert.deepEqual(await consume(), { ok: false });

const retryCreated = await new Promise(resolve => {
  messageListener(
    { type: 'create-reverification-handoff', previousHandoff: successful[0].handoff },
    { url: created.editorURL, tab: { id: 7 } },
    resolve
  );
});
assert.equal(retryCreated.ok, true);
assert.equal(retryCreated.returnURL, returnURL);

const retryClaimed = await new Promise(resolve => {
  messageListener({ type: 'claim-reverification' }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.equal(retryClaimed.ok, true);
assert.match(retryClaimed.handoffID, /^[a-f0-9]{64}$/);
assert.notEqual(retryClaimed.handoffID, editorURL.searchParams.get('handoff'));
assert.equal(retryClaimed.sourceURL, activation.sourceURL);
assert.deepEqual(await new Promise(resolve => {
  messageListener({ type: 'claim-reverification' }, { url: returnURL, tab: { id: 7 } }, resolve);
}), { ok: false });

const retryCompleted = await new Promise(resolve => {
  messageListener(
    {
      type: 'complete-reverification-handoff',
      handoffID: retryClaimed.handoffID,
      sourceIdentity: activation.sourceIdentity
    },
    { url: returnURL, tab: { id: 7 } },
    resolve
  );
});
assert.equal(retryCompleted.ok, true);
assert.doesNotMatch(retryCompleted.editorURL, /oa\.example|documents|Quarterly/i);
const retryConsumed = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: retryClaimed.handoffID },
    { url: retryCompleted.editorURL, tab: { id: 7 } },
    resolve
  );
});
assert.equal(retryConsumed.ok, true);
assert.deepEqual(retryConsumed.handoff.sourceIdentity, activation.sourceIdentity);
assert.deepEqual(await new Promise(resolve => {
  messageListener(
    {
      type: 'complete-reverification-handoff',
      handoffID: retryClaimed.handoffID,
      sourceIdentity: activation.sourceIdentity
    },
    { url: returnURL, tab: { id: 7 } },
    resolve
  );
}), { ok: false });

const invalidRetry = await new Promise(resolve => {
  messageListener(
    { type: 'create-reverification-handoff', previousHandoff: { ...successful[0].handoff, sourcePath: '/documents/Other.docx' } },
    { url: created.editorURL, tab: { id: 7 } },
    resolve
  );
});
assert.deepEqual(invalidRetry, { ok: false });

const docActivation = {
  returnURL,
  sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
  title: 'Legacy Document',
  sourceIdentity: {
    sourcePath: '/documents/Legacy.DOC',
    actualFormat: 'doc',
    byteCount: 3072,
    sha256: 'b'.repeat(64)
  }
};
const createdDoc = await new Promise(resolve => {
  messageListener({ type: 'create-editor-handoff', activation: docActivation }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.equal(createdDoc.ok, true);
const docHandoffID = new URL(createdDoc.editorURL).searchParams.get('handoff');
const consumedDoc = await new Promise(resolve => {
  messageListener({ type: 'consume-editor-handoff', handoffID: docHandoffID }, { url: createdDoc.editorURL, tab: { id: 7 } }, resolve);
});
assert.equal(consumedDoc.ok, true);
assert.equal(consumedDoc.handoff.expectedFormat, 'doc');
assert.deepEqual(consumedDoc.handoff.sourceIdentity, docActivation.sourceIdentity);

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
    { url: senderProtected.editorURL, tab: { id: 7 } },
    resolve
  );
});
assert.equal(rightSender.ok, true);

const expiring = await createHandoff();
now += 120_001;
const expired = await new Promise(resolve => {
  messageListener(
    { type: 'consume-editor-handoff', handoffID: new URL(expiring.editorURL).searchParams.get('handoff') },
    { url: expiring.editorURL, tab: { id: 7 } },
    resolve
  );
});
assert.deepEqual(expired, { ok: false });

// A failed OA read preserves recovery context but never invents an identity.
const failedSource = await new Promise(resolve => {
  messageListener(
    { type: 'create-editor-handoff', activation: { ...activation, sourceIdentity: undefined, sourceVerificationFailed: true } },
    { url: returnURL, tab: { id: 7 } }, resolve
  );
});
assert.equal(failedSource.ok, true);
const failureID = new URL(failedSource.editorURL).searchParams.get('handoff');
const failedConsumed = await new Promise(resolve => {
  messageListener({ type: 'consume-editor-handoff', handoffID: failureID },
    { url: failedSource.editorURL, tab: { id: 7 } }, resolve);
});
assert.equal(failedConsumed.ok, true);
assert.equal(failedConsumed.handoff.sourceVerificationFailed, true);
assert.equal(failedConsumed.handoff.sourceIdentity, undefined);
assert.equal(failedConsumed.handoff.returnURL, returnURL);

// A handoff remains available to its original tab after an unrelated tab probes it.
const bound = await createHandoff();
const boundID = new URL(bound.editorURL).searchParams.get('handoff');
for (const tab of [undefined, { id: 8 }]) {
  assert.deepEqual(await new Promise(resolve => {
    messageListener({ type: 'consume-editor-handoff', handoffID: boundID },
      { url: bound.editorURL, tab }, resolve);
  }), { ok: false });
}
assert.equal((await new Promise(resolve => {
  messageListener({ type: 'consume-editor-handoff', handoffID: boundID },
    { url: bound.editorURL, tab: { id: 7 } }, resolve);
})).ok, true);

const tamperedContext = { ...successful[0].handoff,
  sourceURL: 'https://oa.example.test/documents/Other.docx', sourcePath: '/documents/Other.docx' };
assert.deepEqual(await new Promise(resolve => {
  messageListener({ type: 'create-reverification-handoff', previousHandoff: tamperedContext },
    { url: bound.editorURL, tab: { id: 7 } }, resolve);
}), { ok: false });
const requestRetry = () => new Promise(resolve => {
  messageListener({ type: 'create-reverification-handoff', previousHandoff: successful[0].handoff },
    { url: bound.editorURL, tab: { id: 7 } }, resolve);
});
const duplicateRetryResults = await Promise.all([requestRetry(), requestRetry()]);
assert.equal(duplicateRetryResults.filter(result => result.ok).length, 1);
const failedRetryClaim = await new Promise(resolve => {
  messageListener({ type: 'claim-reverification' }, { url: returnURL, tab: { id: 7 } }, resolve);
});
const failedRetryComplete = await new Promise(resolve => {
  messageListener({ type: 'complete-reverification-handoff', handoffID: failedRetryClaim.handoffID,
    sourceVerificationFailed: true }, { url: returnURL, tab: { id: 7 } }, resolve);
});
assert.equal(failedRetryComplete.ok, true);
const failedRetryConsumed = await new Promise(resolve => {
  messageListener({ type: 'consume-editor-handoff', handoffID: failedRetryClaim.handoffID },
    { url: failedRetryComplete.editorURL, tab: { id: 7 } }, resolve);
});
assert.equal(failedRetryConsumed.handoff.sourceVerificationFailed, true);
assert.equal(failedRetryConsumed.handoff.sourceIdentity, undefined);
assert.equal(failedRetryConsumed.handoff.returnURL, returnURL);

const failedRetryAgain = () => new Promise(resolve => {
  messageListener({ type: 'create-reverification-handoff', previousHandoff: failedRetryConsumed.handoff },
    { url: failedRetryComplete.editorURL, tab: { id: 7 } }, resolve);
});
assert.equal((await new Promise(resolve => {
  messageListener({ type: 'create-reverification-handoff', previousHandoff: failedRetryConsumed.handoff },
    { url: failedRetryComplete.editorURL, tab: { id: 7 } }, resolve);
})).ok, true);
assert.equal((await new Promise(resolve => {
  messageListener({ type: 'cancel-reverification' },
    { url: failedRetryComplete.editorURL, tab: { id: 7 } }, resolve);
})).ok, true);
assert.equal((await new Promise(resolve => {
  messageListener({ type: 'create-reverification-handoff', previousHandoff: failedRetryConsumed.handoff },
    { url: failedRetryComplete.editorURL, tab: { id: 7 } }, resolve);
})).ok, true);

// Closing the source tab removes both retry context and unconsumed handoffs.
const closing = await createHandoff();
await tabRemovedListener(7);
assert.deepEqual(await new Promise(resolve => {
  messageListener({ type: 'consume-editor-handoff', handoffID: new URL(closing.editorURL).searchParams.get('handoff') },
    { url: closing.editorURL, tab: { id: 7 } }, resolve);
}), { ok: false });
