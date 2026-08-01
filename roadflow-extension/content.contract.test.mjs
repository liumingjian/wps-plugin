import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let clickListener;
let storageListener;
let replacementURL;
const messages = [];

globalThis.chrome = {
  runtime: {
    async sendMessage(message) {
      messages.push(message);
      if (message.type === 'configuration') {
        return { ok: true, configuration: { trustedOrigin: 'https://oa.example.test' } };
      }
      return { ok: true, editorURL: 'chrome-extension://fixed/editor.html?handoff=opaque-id' };
    }
  },
  storage: {
    onChanged: { addListener(listener) { storageListener = listener; } }
  }
};
globalThis.document = {
  addEventListener(type, listener, capture) {
    assert.equal(type, 'click');
    assert.equal(capture, true);
    clickListener = listener;
  }
};
globalThis.location = {
  href: 'https://oa.example.test/workflow/current?step=review#document',
  origin: 'https://oa.example.test',
  replace(url) { replacementURL = url; }
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
assert.deepEqual(messages, [
  { type: 'configuration' },
  {
    type: 'create-editor-handoff',
    activation: {
      returnURL: 'https://oa.example.test/workflow/current?step=review#document',
      sourceURL: 'https://oa.example.test/documents/Quarterly%20Report.DOCX?download=1',
      title: 'Quarterly Report'
    }
  }
]);
assert.equal(replacementURL, 'chrome-extension://fixed/editor.html?handoff=opaque-id');

for (const activation of [
  { isTrusted: false, href: 'https://oa.example.test/documents/report.docx' },
  { ctrlKey: true, href: 'https://oa.example.test/documents/report.docx' },
  { button: 1, href: 'https://oa.example.test/documents/report.docx' },
  { href: 'https://files.example.test/documents/report.docx' },
  { href: 'https://oa.example.test/download?next=/documents/report.docx' },
  { href: 'javascript:submitDocument()' },
  { href: 'https://oa.example.test/documents/report.pdf' }
]) {
  let passThroughPrevented = false;
  const messageCount = messages.length;
  clickListener({
    isTrusted: activation.isTrusted ?? true,
    button: activation.button ?? 0,
    altKey: activation.altKey ?? false,
    ctrlKey: activation.ctrlKey ?? false,
    metaKey: activation.metaKey ?? false,
    shiftKey: activation.shiftKey ?? false,
    defaultPrevented: false,
    preventDefault() { passThroughPrevented = true; },
    target: {
      closest() { return { href: activation.href, textContent: 'Document' }; }
    }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(passThroughPrevented, false, `prevented ${activation.href}`);
  assert.equal(messages.length, messageCount, `created handoff for ${activation.href}`);
}

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
