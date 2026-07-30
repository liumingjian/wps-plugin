const PAGE_SOURCE = 'local-wps-editing-sdk';
const EXTENSION_SOURCE = 'local-wps-editing-extension';
let port;

function extensionPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: 'page-sdk' });
  port.onMessage.addListener(message => {
    window.postMessage({ source: EXTENSION_SOURCE, ...message }, window.location.origin);
  });
  port.onDisconnect.addListener(() => { port = undefined; });
  return port;
}

window.addEventListener('message', event => {
  const request = event.data;
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!['http:', 'https:'].includes(window.location.protocol) || request?.source !== PAGE_SOURCE) return;
  if (!['get-readiness', 'open'].includes(request.operation) || typeof request.requestId !== 'string') return;
  extensionPort().postMessage({
    kind: 'page-request',
    requestId: request.requestId,
    operation: request.operation,
    input: request.input,
    userActivation: navigator.userActivation?.isActive === true
  });
});
