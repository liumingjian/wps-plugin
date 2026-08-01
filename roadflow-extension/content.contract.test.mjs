import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let clickListener;
let storageListener;
let replacementURL;
const validIdentity = {
  sourcePath: '/documents/Quarterly%20Report.DOCX',
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: 'a'.repeat(64)
};
let nextIdentityResult = {
  ok: true,
  identity: validIdentity
};
const messages = [];
const identityRequests = [];
const alerts = [];
const docFetches = [];
let handoffResponse = { ok: true, editorURL: 'chrome-extension://fixed/editor.html?handoff=opaque-id' };

globalThis.RoadFlowSourceIdentity = {
  async derive(sourceURL, expectedFormat) {
    identityRequests.push({ sourceURL, expectedFormat });
    const result = nextIdentityResult;
    nextIdentityResult = { ...nextIdentityResult, ok: true };
    return result;
  }
};

globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'configuration') {
        return { ok: true, configuration: { trustedOrigin: 'https://oa.example.test' } };
      }
      if (handoffResponse instanceof Error) throw handoffResponse;
      return handoffResponse;
    }
  },
  storage: {
    onChanged: { addListener(listener) { storageListener = listener; } }
  }
};
globalThis.window = {
  addEventListener(type, listener, capture) {
    assert.equal(type, 'click');
    assert.equal(capture, false);
    clickListener = listener;
  },
  alert(message) { alerts.push(message); }
};
globalThis.location = {
  href: 'https://oa.example.test/workflow/current?step=review#document',
  origin: 'https://oa.example.test',
  replace(url) { replacementURL = url; }
};
globalThis.fetch = async (url, options) => {
  docFetches.push({ url, options });
  return { ok: true, status: 200, type: 'basic', redirected: false, url, body: { async cancel() {} } };
};

vm.runInThisContext(await readFile(new URL('./content.js', import.meta.url), 'utf8'), { filename: 'content.js' });
await new Promise(resolve => setImmediate(resolve));

let prevented = false;
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() { prevented = true; },
  target: {
    closest(selector) {
      assert.equal(selector, 'a[href]');
      return {
        href: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
        textContent: ' Quarterly Report '
      };
    }
  }
});
await new Promise(resolve => setImmediate(resolve));

assert.equal(prevented, true);
assert.deepEqual(identityRequests, [{
  sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
  expectedFormat: 'docx'
}]);
assert.deepEqual(messages, [
  { type: 'configuration' },
  {
    type: 'create-editor-handoff',
    activation: {
      returnURL: 'https://oa.example.test/workflow/current?step=review#document',
      sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
      title: 'Quarterly Report',
      sourceIdentity: validIdentity
    }
  }
]);
assert.equal(replacementURL, 'chrome-extension://fixed/editor.html?handoff=opaque-id');

const docMessageCount = messages.length;
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() {},
  target: {
    closest() { return { href: 'https://oa.example.test/documents/Legacy.DOC', textContent: 'Legacy Document' }; }
  }
});
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(docFetches, [{
  url: 'https://oa.example.test/documents/Legacy.DOC',
  options: { cache: 'no-store', credentials: 'include', redirect: 'manual' }
}]);
assert.deepEqual(messages.at(-1), {
  type: 'create-editor-handoff',
  activation: {
    returnURL: 'https://oa.example.test/workflow/current?step=review#document',
    sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
    title: 'Legacy Document'
  }
});
assert.equal(messages.length, docMessageCount + 1);

for (const activation of [
  { isTrusted: false, href: 'https://oa.example.test/documents/report.docx' },
  { defaultPrevented: true, href: 'https://oa.example.test/documents/report.docx' },
  { ctrlKey: true, href: 'https://oa.example.test/documents/report.docx' },
  { button: 1, href: 'https://oa.example.test/documents/report.docx' },
  { href: 'https://files.example.test/documents/report.docx' },
  { href: 'https://oa.example.test/download?next=/documents/report.docx' },
  { href: 'javascript:submitDocument()' },
  { href: 'https://oa.example.test/documents/report.pdf' }
]) {
  let passThroughPrevented = false;
  const messageCount = messages.length;
  const identityRequestCount = identityRequests.length;
  clickListener({
    isTrusted: activation.isTrusted ?? true,
    button: activation.button ?? 0,
    altKey: activation.altKey ?? false,
    ctrlKey: activation.ctrlKey ?? false,
    metaKey: activation.metaKey ?? false,
    shiftKey: activation.shiftKey ?? false,
    defaultPrevented: activation.defaultPrevented ?? false,
    preventDefault() { passThroughPrevented = true; },
    target: {
      closest() { return { href: activation.href, textContent: 'Document' }; }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(passThroughPrevented, false, `prevented ${activation.href}`);
  assert.equal(messages.length, messageCount, `created handoff for ${activation.href}`);
  assert.equal(identityRequests.length, identityRequestCount, `validated ${activation.href}`);
}

nextIdentityResult = { ok: false, message: 'Document verification failed. Editing was not opened.' };
replacementURL = undefined;
let failurePrevented = false;
const failureMessageCount = messages.length;
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() { failurePrevented = true; },
  target: {
    closest() { return { href: 'https://oa.example.test/documents/redirected.docx', textContent: 'Document' }; }
  }
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(failurePrevented, true);
assert.equal(replacementURL, undefined);
assert.equal(messages.length, failureMessageCount);
assert.deepEqual(alerts, ['Document verification failed. Editing was not opened.']);

nextIdentityResult = { ok: true, identity: validIdentity };
handoffResponse = { ok: false };
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() {},
  target: {
    closest() { return { href: 'https://oa.example.test/documents/Quarterly%20Report.DOCX', textContent: 'Document' }; }
  }
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(replacementURL, undefined);
assert.deepEqual(alerts, [
  'Document verification failed. Editing was not opened.',
  'Document verification failed. Editing was not opened.'
]);

storageListener({
  roadFlowIntegration: {
    oldValue: { trustedOrigin: 'https://oa.example.test' },
    newValue: { trustedOrigin: 'https://new-oa.example.test' }
  }
}, 'local');
let staleConfigurationPrevented = false;
const messageCount = messages.length;
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() { staleConfigurationPrevented = true; },
  target: { closest() { return { href: 'https://oa.example.test/documents/report.docx', textContent: 'Document' }; } }
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(staleConfigurationPrevented, false);
assert.equal(messages.length, messageCount);
