import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let clickListener;
let storageListener;
let replacementURL;
const openedWindows = [];
const validIdentity = {
  sourcePath: '/documents/Quarterly Report.DOCX',
  actualFormat: 'docx',
  byteCount: 4096,
  sha256: 'a'.repeat(64)
};
let nextIdentityResult = {
  ok: true,
  identity: validIdentity
};
let identityResults = [];
const messages = [];
const identityRequests = [];
const alerts = [];
const assetFetches = [];
const debugLogs = [];
let generatedEditorBlob;
const hostedHandoff = 'e'.repeat(64);
const hostedLaunch = {
  documentURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
  expectedFormat: 'docx',
  handoff: hostedHandoff,
  officeSaveURL: 'https://oa.example.test/RoadFlow/uploadfiles/OfficeSave?fileurl=%2Fdocuments%2FQuarterly%2520Report.DOCX',
  returnMode: 'close',
  returnURL: 'https://oa.example.test/workflow/current?step=review#document',
  sourceIdentity: validIdentity,
  sourcePath: validIdentity.sourcePath,
  title: 'Quarterly Report'
};
let handoffResponse = { ok: true, editorLaunch: hostedLaunch };

class FakeElement {
  constructor(kind, parsed) {
    this.kind = kind;
    this.parsed = parsed;
    this.textContent = '';
  }

  replaceWith(element) { this.parsed.style = element; }
  before(element) { this.parsed.contextScript = element; }
  removeAttribute() {}
}

globalThis.DOMParser = class {
  parseFromString(html, type) {
    assert.equal(type, 'text/html');
    assert.match(html, /hosted-editor\.css/);
    const parsed = {
      querySelector(selector) {
        if (selector === 'link[rel="stylesheet"]') return new FakeElement('link', parsed);
        if (selector === 'script[src]') return parsed.editorScript;
        return undefined;
      },
      createElement(kind) { return new FakeElement(kind, parsed); }
    };
    parsed.editorScript = new FakeElement('script', parsed);
    parsed.documentElement = {
      get outerHTML() {
        return `<html><style>${parsed.style.textContent}</style><script>${parsed.contextScript.textContent}</script><script>${parsed.editorScript.textContent}</script></html>`;
      }
    };
    return parsed;
  }
};
URL.createObjectURL = blob => {
  generatedEditorBlob = blob;
  return `blob:https://oa.example.test/${hostedHandoff}`;
};

globalThis.RoadFlowSourceIdentity = {
  async derive(sourceURL, expectedFormat) {
    identityRequests.push({ sourceURL, expectedFormat });
    const result = identityResults.shift() || nextIdentityResult;
    nextIdentityResult = { ...nextIdentityResult, ok: true };
    return result;
  }
};

globalThis.chrome = {
  runtime: {
    id: 'fixed',
    getManifest() { return { version: 'test' }; },
    getURL(path) { return `chrome-extension://fixed/${path}`; },
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
const originalConsoleInfo = console.info;
console.info = (...args) => debugLogs.push(args);
globalThis.window = {
  top: undefined,
  open(url, target) {
    assert.equal(url, 'about:blank');
    assert.equal(target, '_blank');
    const editorWindow = {
      closed: false,
      location: {
        replace(nextURL) {
          editorWindow.replacedURL = nextURL;
          replacementURL = nextURL;
        }
      },
      close() { editorWindow.closed = true; }
    };
    openedWindows.push(editorWindow);
    return editorWindow;
  },
  addEventListener(type, listener, capture) {
    if (type === 'click') {
      assert.equal(capture, false);
      clickListener = listener;
      return;
    }
    assert.fail(`unexpected event listener: ${type}`);
  },
  alert(message) { alerts.push(message); }
};
globalThis.location = {
  href: 'https://oa.example.test/workflow/current?step=review#document',
  origin: 'https://oa.example.test',
  replace(url) { replacementURL = url; }
};
globalThis.fetch = async (url, options) => {
  assetFetches.push({ url, options });
  const name = String(url).split('/').at(-1);
  const contents = {
    'hosted-editor.html': '<html><head><link rel="stylesheet" href="hosted-editor.css"></head><body><script src="hosted-editor.js"></script></body></html>',
    'hosted-editor.css': '#editor-host { width: 100%; }',
    'format-capabilities.js': 'globalThis.RoadFlowFormatCapabilities = { forFormat() {}, forPath() {} };',
    'hosted-editor.js': 'globalThis.hostedEditorStarted = true;'
  };
  return { ok: name in contents, async text() { return contents[name]; } };
};

vm.runInThisContext(await readFile(new URL('./format-capabilities.js', import.meta.url), 'utf8'), { filename: 'format-capabilities.js' });
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
      returnMode: 'close',
      sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
      title: 'Quarterly Report',
      sourceIdentity: validIdentity
    }
  }
]);
assert.equal(replacementURL, `blob:https://oa.example.test/${hostedHandoff}`);
assert.equal(openedWindows.length, 1);
assert.equal(openedWindows[0].replacedURL, `blob:https://oa.example.test/${hostedHandoff}`);
assert.deepEqual(assetFetches.map(request => request.url), [
  'chrome-extension://fixed/hosted-editor.html',
  'chrome-extension://fixed/hosted-editor.css',
  'chrome-extension://fixed/hosted-editor.js',
  'chrome-extension://fixed/format-capabilities.js'
]);
const generatedHTML = await generatedEditorBlob.text();
assert.match(generatedHTML, /#editor-host \{ width: 100%; \}/);
assert.match(generatedHTML, /RoadFlowEditorContext/);
assert.match(generatedHTML, /hostedEditorStarted = true/);
assert.doesNotMatch(generatedHTML, /chrome-extension:\/\/fixed\/editor\.html/);

const debugEvents = () => debugLogs.map(([message]) => message);
assert.ok(debugEvents().includes('[RoadFlow WPS debug] content-script-loaded'));
assert.ok(debugEvents().includes('[RoadFlow WPS debug] configuration-received'));
assert.ok(debugEvents().includes('[RoadFlow WPS debug] document-link-click-observed'));
assert.ok(debugEvents().includes('[RoadFlow WPS debug] document-link-intercepted'));
assert.ok(debugEvents().includes('[RoadFlow WPS debug] document-verification-succeeded'));
assert.ok(debugEvents().includes('[RoadFlow WPS debug] editor-handoff-response'));

identityResults = [
  { ok: false, message: 'Document verification failed. Editing was not opened.' },
  { ok: false, message: 'Document verification failed. Editing was not opened.' },
  { ok: true, identity: validIdentity }
];
handoffResponse = { ok: true, editorLaunch: hostedLaunch };
const transientFailureWindowCount = openedWindows.length;
const transientFailureMessageCount = messages.length;
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
await new Promise(resolve => setTimeout(resolve, 1100));
assert.equal(identityRequests.at(-3).expectedFormat, 'docx');
assert.equal(identityRequests.at(-2).expectedFormat, 'docx');
assert.equal(identityRequests.at(-1).expectedFormat, 'docx');
assert.equal(openedWindows.length, transientFailureWindowCount + 1);
assert.equal(messages.length, transientFailureMessageCount + 1);
assert.equal(openedWindows.at(-1).replacedURL, `blob:https://oa.example.test/${hostedHandoff}`);

const docMessageCount = messages.length;
const validDOCIdentity = {
  sourcePath: '/documents/Legacy.DOC',
  actualFormat: 'doc',
  byteCount: 3072,
  sha256: 'b'.repeat(64)
};
handoffResponse = {
  ok: true,
  editorLaunch: {
    documentURL: 'https://oa.example.test/documents/Legacy.DOC',
    expectedFormat: 'doc',
    handoff: 'f'.repeat(64),
    officeSaveURL: 'https://oa.example.test/RoadFlow/uploadfiles/OfficeSave?fileurl=%2Fdocuments%2FLegacy.DOC',
    returnURL: 'https://oa.example.test/workflow/current?step=review#document',
    sourceIdentity: validDOCIdentity,
    sourcePath: validDOCIdentity.sourcePath,
    title: 'Legacy Document'
  }
};
nextIdentityResult = { ok: true, identity: validDOCIdentity };
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
assert.deepEqual(identityRequests.at(-1), {
  sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
  expectedFormat: 'doc'
});
assert.equal(assetFetches.length, 12);
assert.deepEqual(messages.at(-1), {
  type: 'create-editor-handoff',
  activation: {
    returnURL: 'https://oa.example.test/workflow/current?step=review#document',
    returnMode: 'close',
    sourceURL: 'https://oa.example.test/documents/Legacy.DOC',
    title: 'Legacy Document',
    sourceIdentity: validDOCIdentity
  }
});
assert.equal(messages.length, docMessageCount + 1);

handoffResponse = { ok: true, editorLaunch: hostedLaunch };
nextIdentityResult = { ok: true, identity: validIdentity };
globalThis.location.href = 'https://oa.example.test/workflow/form-frame?id=7';
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  defaultPrevented: false,
  preventDefault() {},
  target: {
    closest() { return { href: 'https://oa.example.test/documents/Quarterly%20Report.DOCX', textContent: 'Document' }; }
  }
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(messages.at(-1).activation.returnURL, 'https://oa.example.test/workflow/form-frame?id=7');
assert.equal(openedWindows.length, 4);
assert.equal(openedWindows.at(-1).replacedURL, `blob:https://oa.example.test/${hostedHandoff}`);
globalThis.location.href = 'https://oa.example.test/workflow/current?step=review#document';

for (const [format, editorKind] of [
  ['wps', 'writer'],
  ['xls', 'spreadsheet'],
  ['xlsx', 'spreadsheet']
]) {
  const sourcePath = `/documents/Quarterly-Report.${format.toUpperCase()}`;
  const sourceURL = `https://oa.example.test${sourcePath}`;
  const identity = {
    sourcePath,
    actualFormat: format,
    byteCount: 4096,
    sha256: 'a'.repeat(64)
  };
  handoffResponse = {
    ok: true,
    editorLaunch: {
      documentURL: sourceURL,
      editorKind,
      expectedFormat: format,
      handoff: ['c', 'd', 'e'][['wps', 'xls', 'xlsx'].indexOf(format)].repeat(64),
      officeSaveURL: `https://oa.example.test/RoadFlow/uploadfiles/OfficeSave?fileurl=${encodeURIComponent(sourcePath)}`,
      returnURL: 'https://oa.example.test/workflow/current?step=review#document',
      sourceIdentity: identity,
      sourcePath,
      title: `Quarterly Report.${format.toUpperCase()}`
    }
  };
  nextIdentityResult = { ok: true, identity };
  let formatPrevented = false;
  clickListener({
    isTrusted: true,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { formatPrevented = true; },
    target: {
      closest() { return { href: sourceURL, textContent: `Quarterly Report.${format.toUpperCase()}` }; }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(formatPrevented, true);
  assert.deepEqual(identityRequests.at(-1), { sourceURL, expectedFormat: format });
  assert.equal(messages.at(-1).activation.sourceIdentity.actualFormat, format);
}

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
await new Promise(resolve => setTimeout(resolve, 1100));
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
await new Promise(resolve => setTimeout(resolve, 1100));
assert.equal(replacementURL, undefined);
assert.deepEqual(alerts, [
  'Document verification failed. Editing was not opened.',
  'Document verification failed. Editing was not opened.'
]);

handoffResponse = { ok: true, editorLaunch: hostedLaunch };
nextIdentityResult = { ok: true, identity: validIdentity };
storageListener({
  roadFlowIntegration: {
    oldValue: { trustedOrigin: 'https://oa.example.test' },
    newValue: { trustedOrigin: '' }
  }
}, 'local');
let allOriginsPrevented = false;
const allOriginsMessageCount = messages.length;
clickListener({
  isTrusted: true,
  button: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() { allOriginsPrevented = true; },
  target: {
    closest() {
      return { href: 'https://files.example.test/documents/External.DOCX', textContent: 'External Document' };
    }
  }
});
await new Promise(resolve => setImmediate(resolve));
assert.equal(allOriginsPrevented, true);
assert.equal(messages.length, allOriginsMessageCount + 1);
assert.equal(messages.at(-1).activation.sourceURL, 'https://files.example.test/documents/External.DOCX');
assert.deepEqual(identityRequests.at(-1), {
  sourceURL: 'https://files.example.test/documents/External.DOCX',
  expectedFormat: 'docx'
});

storageListener({
  roadFlowIntegration: {
    oldValue: { trustedOrigin: '' },
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
assert.ok(debugLogs.some(([message, details]) =>
  message === '[RoadFlow WPS debug] document-link-skipped' &&
  details.reasons.includes('source-origin-not-trusted')));
assert.ok(debugLogs.some(([message, details]) =>
  message === '[RoadFlow WPS debug] document-link-skipped' &&
  details.reasons.includes('unsupported-extension')));
console.info = originalConsoleInfo;
