import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

let messageListener;
let stored = {};
const extensionOrigin = 'chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd';

globalThis.chrome = {
  runtime: {
    getURL(path) { return `${extensionOrigin}/${path}`; },
    onMessage: { addListener(listener) { messageListener = listener; } }
  },
  storage: {
    local: {
      async get() { return stored; },
      async set(update) { stored = { ...stored, ...update }; }
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
assert.deepEqual(stored, { roadFlowIntegration: configuration });

const rejected = await new Promise(resolve => {
  messageListener(
    { type: 'apply-configuration', configuration },
    { url: 'https://oa.example.test/settings' },
    resolve
  );
});
assert.deepEqual(rejected, { ok: false, message: 'Configuration request was not authorized.' });
