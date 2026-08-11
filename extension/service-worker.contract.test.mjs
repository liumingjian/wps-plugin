import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let messageListener;
let storedOrigins = [];
globalThis.chrome = {
  runtime: {
    getURL(path) { return `chrome-extension://extension-id/${path}`; },
    onConnect: { addListener() {} },
    onMessage: { addListener(listener) { messageListener = listener; } },
    onStartup: { addListener() {} }
  },
  storage: {
    local: {
      async get() { return { trustedOrigins: storedOrigins }; },
      async set(value) { storedOrigins = value.trustedOrigins; }
    }
  },
  tabs: {
    async get(tabId) {
      assert.equal(tabId, 7);
      return { id: 7, url: 'http://192.168.122.57:4317/document/1' };
    },
    async query() {
      return [{ id: 3, url: 'http://127.0.0.1:4317/' }];
    }
  }
};

vm.runInThisContext(await readFile(new URL('./service-worker.js', import.meta.url), 'utf8'), { filename: 'service-worker.js' });

const response = await new Promise(resolve => {
  const request = { type: 'trust-origin', tabId: 7, origin: 'http://192.168.122.57:4317' };
  const sender = { url: 'chrome-extension://extension-id/popup.html' };
  assert.equal(messageListener(request, sender, resolve), true);
});
assert.deepEqual(response, { ok: true, origin: 'http://192.168.122.57:4317' });
assert.deepEqual(storedOrigins, ['http://192.168.122.57:4317']);

const popupSource = await readFile(new URL('./popup.js', import.meta.url), 'utf8');
assert.match(popupSource, /type:\s*['"]trust-origin['"],\s*tabId:/);
