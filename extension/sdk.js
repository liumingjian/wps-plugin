(() => {
  'use strict';

  const PAGE_SOURCE = 'local-wps-editing-sdk';
  const EXTENSION_SOURCE = 'local-wps-editing-extension';
  const pending = new Map();
  const tasks = new Map();
  let nextRequest = 0;

  class WpsEditError extends Error {
    constructor(value = {}) {
      super(value.message || 'Local WPS Editing failed.');
      this.name = 'WpsEditError';
      this.code = value.code || 'INTERNAL_ERROR';
      this.phase = value.phase || 'open';
      this.disposition = value.disposition || 'terminal';
      if (value.action) this.action = value.action;
      if (value.taskId) this.taskId = value.taskId;
      if (value.snapshotSequence) this.snapshotSequence = value.snapshotSequence;
    }
  }

  function request(operation, input) {
    const requestId = `wps-edit-${Date.now()}-${++nextRequest}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new WpsEditError({ code: 'EXTENSION_UNAVAILABLE', phase: 'open', message: 'Local WPS Editing did not respond.' }));
      }, 10000);
      pending.set(requestId, { resolve, reject, timeout });
      window.postMessage({ source: PAGE_SOURCE, requestId, operation, input }, window.location.origin);
    });
  }

  function normalizedOpenInput(input) {
    if (!input || (Boolean(input.documentId) === Boolean(input.taskId))) {
      throw new WpsEditError({ code: 'INVALID_TASK', phase: 'create', message: 'Provide exactly one Document ID or Editing Task ID.' });
    }
    if (input.contractVersion !== 1) {
      throw new WpsEditError({ code: 'UNSUPPORTED_CONTRACT', phase: 'create', message: 'Contract version 1 is required.' });
    }
    const url = new URL(input.editingTasksUrl, window.location.href);
    if (url.origin !== window.location.origin || !['http:', 'https:'].includes(url.protocol)) {
      throw new WpsEditError({ code: 'INVALID_TASK', phase: 'create', message: 'The Editing Task URL must be same-Origin.' });
    }
    return { documentId: input.documentId, taskId: input.taskId, editingTasksUrl: url.href, contractVersion: 1 };
  }

  function createHandle(taskId) {
    let complete;
    let fail;
    const completion = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const state = { listeners: new Set(), completion, complete, fail, lastSequence: 0 };
    tasks.set(taskId, state);
    return {
      subscribe(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      completion
    };
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== EXTENSION_SOURCE) return;
    const message = event.data;
    if (message.requestId && pending.has(message.requestId)) {
      const operation = pending.get(message.requestId);
      clearTimeout(operation.timeout);
      pending.delete(message.requestId);
      if (message.status === 'failed') operation.reject(new WpsEditError(message.error || message));
      else operation.resolve(message);
      return;
    }
    const state = tasks.get(message.taskId);
    if (!state || !message.event) return;
    const taskEvent = Object.freeze({ ...message.event });
    if (!Number.isInteger(taskEvent.eventSequence) || taskEvent.eventSequence <= state.lastSequence) return;
    state.lastSequence = taskEvent.eventSequence;
    for (const listener of state.listeners) {
      try { listener(taskEvent); } catch { /* Subscriber failures do not control the Editing Task. */ }
    }
    if (taskEvent.type === 'task-completed') state.complete(taskEvent);
    if (taskEvent.type === 'task-failed') state.fail(new WpsEditError(taskEvent.error || taskEvent));
  });

  window.WpsEdit = Object.freeze({
    async getReadiness() {
      const response = await request('get-readiness');
      return Object.freeze(response.readiness);
    },
    async open(input) {
      const response = await request('open', normalizedOpenInput(input));
      return createHandle(response.taskId);
    }
  });
})();
