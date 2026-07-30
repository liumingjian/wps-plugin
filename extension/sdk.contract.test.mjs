import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

globalThis.window = globalThis;
globalThis.location = new URL('https://oa.example.test/document/7');
const listeners = new Map();
window.addEventListener = (type, listener) => listeners.set(type, listener);
window.removeEventListener = () => {};
let outgoing;
window.postMessage = (message, origin) => {
  assert.equal(origin, location.origin);
  outgoing = message;
};
const reply = (message) => listeners.get('message')({ source: window, origin: location.origin, data: message });

vm.runInThisContext(await readFile(new URL('./sdk.js', import.meta.url), 'utf8'), { filename: 'sdk.js' });
assert.deepEqual(Object.keys(WpsEdit).sort(), ['getReadiness', 'open']);

const readinessPromise = WpsEdit.getReadiness();
assert.equal(outgoing.operation, 'get-readiness');
reply({ source: 'local-wps-editing-extension', requestId: outgoing.requestId, status: 'completed', readiness: { state: 'ready', contractVersions: [1], submissionProfiles: ['raw-body-v1'] } });
assert.equal((await readinessPromise).state, 'ready');

const handlePromise = WpsEdit.open({ documentId: 'document-7', editingTasksUrl: '/editing-tasks', contractVersion: 1 });
assert.equal(outgoing.operation, 'open');
assert.equal(outgoing.input.editingTasksUrl, 'https://oa.example.test/editing-tasks');
reply({ source: 'local-wps-editing-extension', requestId: outgoing.requestId, status: 'accepted', taskId: 'task-7' });
const handle = await handlePromise;
assert.deepEqual(Object.keys(handle).sort(), ['completion', 'subscribe']);
const events = [];
const unsubscribe = handle.subscribe(event => events.push(event));
reply({ source: 'local-wps-editing-extension', taskId: 'task-7', event: { type: 'wps-opened', taskId: 'task-7', eventSequence: 1 } });
reply({ source: 'local-wps-editing-extension', taskId: 'task-7', event: { type: 'task-completed', taskId: 'task-7', eventSequence: 2, outcome: 'submitted' } });
assert.deepEqual(events.map(event => event.type), ['wps-opened', 'task-completed']);
assert.equal((await handle.completion).outcome, 'submitted');
unsubscribe();
