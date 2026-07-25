window.addEventListener('message', (event) => {
  const request = event.data;
  if (event.source !== window || event.origin !== 'http://127.0.0.1:4317' || request?.source !== 'wps-edit-demo') return;
  chrome.runtime.sendMessage(request, (response) => {
    const reply = chrome.runtime.lastError
      ? { version: 1, status: 'failed', taskId: request.taskId, message: chrome.runtime.lastError.message }
      : response;
    window.postMessage({ source: 'wps-edit-extension', ...reply }, window.location.origin);
  });
});
