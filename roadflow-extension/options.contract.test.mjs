import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./options.js', import.meta.url), 'utf8');
const configuration = await readFile(new URL('./configuration.js', import.meta.url), 'utf8');
let submit;
let stored;
const requestedOrigins = [];
const input = { value: 'http://127.0.0.1:3000' };
const message = { textContent: '' };
const form = {
  addEventListener(type, listener) {
    assert.equal(type, 'submit');
    submit = listener;
  }
};
const chrome = {
  permissions: {
    async request({ origins }) { requestedOrigins.push(origins); return true; },
    async contains() { return true; },
    async remove() {}
  },
  runtime: {
    async sendMessage() {
      throw new Error('stale Service Worker must not block setup');
    }
  },
  storage: {
    local: {
      async get() { return {}; },
      async set(value) { stored = value; }
    }
  }
};

const context = vm.createContext({
  assert,
  chrome,
  console,
  document: {
    querySelector(selector) {
      return selector === '#setup-form' ? form : selector === '#trusted-origin' ? input : message;
    }
  },
  URL
});
vm.runInContext(configuration, context, { filename: 'configuration.js' });
vm.runInContext(source, context, { filename: 'options.js' });
assert.equal(typeof submit, 'function');

await submit({ preventDefault() {} });
assert.deepEqual(JSON.parse(JSON.stringify(stored)), {
  roadFlowIntegration: { trustedOrigin: 'http://127.0.0.1:3000' }
});
assert.equal(message.textContent, 'Configuration saved for this browser profile.');

input.value = '';
await submit({ preventDefault() {} });
assert.deepEqual(JSON.parse(JSON.stringify(stored)), {
  roadFlowIntegration: { trustedOrigin: '' }
});
assert.deepEqual(JSON.parse(JSON.stringify(requestedOrigins.at(-1))), ['http://*/*', 'https://*/*']);
assert.equal(message.textContent, 'Configuration saved for this browser profile.');
