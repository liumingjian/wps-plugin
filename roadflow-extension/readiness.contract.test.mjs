import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

vm.runInThisContext(await readFile(new URL('./configuration.js', import.meta.url), 'utf8'), { filename: 'configuration.js' });
vm.runInThisContext(await readFile(new URL('./readiness.js', import.meta.url), 'utf8'), { filename: 'readiness.js' });

const validConfiguration = {
  trustedOrigin: 'https://oa.example.test',
  gatewayTemplate: 'https://gateway.example.test/wps?fileurl={sourcePath}'
};
const cases = [
  [{}, { npapiAvailable: true }, 'missing-configuration', 'Open extension settings'],
  [validConfiguration, { npapiAvailable: false }, 'wps-npapi-unavailable', 'Verify the designated WPS installation'],
  [validConfiguration, { npapiAvailable: true }, 'ready', 'ready for RoadFlow']
];
for (const [configuration, environment, state, guidance] of cases) {
  const result = RoadFlowReadiness.evaluate(configuration, environment);
  assert.equal(result.state, state);
  assert.match(result.guidance, new RegExp(guidance, 'i'));
}

const targetEnvironment = RoadFlowReadiness.detectEnvironment(
  { Application() {} },
  {
    plugins: [{ name: 'Kingsoft WPS Plugin' }],
    mimeTypes: { namedItem(type) { return type === 'application/x-wps' ? { type } : undefined; } }
  }
);
assert.deepEqual(targetEnvironment, { npapiAvailable: true });
assert.deepEqual(RoadFlowReadiness.detectEnvironment(
  { Application: null },
  { plugins: [{ name: 'Kingsoft WPS Plugin' }], mimeTypes: { namedItem() { return {}; } } }
), { npapiAvailable: false });

const body = {
  dataset: {},
  append(probe) {
    this.probe = probe;
    if (!probe.hidden) probe.Application = function () {};
  }
};
const probe = { style: {}, setAttribute() {} };
const label = { addEventListener() {} };
const context = vm.createContext({
  chrome: { storage: { local: { async get() { return { roadFlowIntegration: validConfiguration }; } } } },
  document: {
    body,
    createElement() { return probe; },
    querySelector() { return label; }
  },
  navigator: { mimeTypes: { namedItem() { return {}; } } },
  URL,
  setTimeout(callback) { queueMicrotask(callback); }
});
for (const filename of ['configuration.js', 'readiness.js']) {
  vm.runInContext(await readFile(new URL(filename, import.meta.url), 'utf8'), context, { filename });
}
await new Promise(resolve => setImmediate(resolve));
assert.equal(body.dataset.readiness, 'ready');
