// PROTOTYPE: bridge only explicit SDK messages; never inspect page content.
const PAGE_SOURCE = 'wps-edit-sdk-prototype';
const EXTENSION_SOURCE = 'wps-edit-extension-prototype';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  if (event.data?.source !== PAGE_SOURCE) return;

  chrome.runtime.sendMessage({ kind: 'page-request', request: event.data }, (response) => {
    const reply = chrome.runtime.lastError
      ? { version: 1, status: 'failed', code: 'extension_error', message: chrome.runtime.lastError.message }
      : response;
    window.postMessage({ source: EXTENSION_SOURCE, ...reply }, event.origin);
  });
});
