// PROTOTYPE: exposes only fixed probe operations and same-origin Demo task URLs.
const HOST = 'com.liumingjian.wps_edit_agent';
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_TYPES = new Set(['ping', 'task-start', 'notification-probe']);

function failed(code, message, request = {}) {
  return {
    version: 1,
    type: 'error',
    status: 'failed',
    code,
    message,
    taskId: request.taskId,
    documentId: request.documentId,
    extensionVersion: chrome.runtime.getManifest().version
  };
}

function senderOrigin(sender) {
  try {
    const url = new URL(sender.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function sameOriginEndpoint(value, origin, suffix) {
  try {
    const url = new URL(value);
    return url.origin === origin && url.pathname.startsWith('/documents/') && url.pathname.endsWith(suffix) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validate(request, sender) {
  if (!request || request.source !== 'wps-edit-sdk-prototype' || request.version !== 1 || !ALLOWED_TYPES.has(request.type)) {
    return failed('invalid_request', 'The page request does not match the prototype protocol.', request);
  }
  const origin = senderOrigin(sender);
  if (!origin) return failed('invalid_origin', 'Only ordinary HTTP/HTTPS pages may use the prototype bridge.', request);
  if (request.type === 'notification-probe') {
    if (!['success', 'failure'].includes(request.outcome)) return failed('invalid_notification', 'Notification outcome must be success or failure.', request);
    return null;
  }
  if (request.type === 'ping') return null;
  if (!ID_PATTERN.test(request.taskId || '') || !ID_PATTERN.test(request.documentId || '')) {
    return failed('invalid_task', 'Editing Task and Document IDs must use the narrow prototype identifier format.', request);
  }
  if (!sameOriginEndpoint(request.downloadUrl, origin, '/content') || !sameOriginEndpoint(request.uploadUrl, origin, '/submissions')) {
    return failed('invalid_url', 'Download and upload endpoints must be same-origin Document endpoints.', request);
  }
  return null;
}

function showNotification(outcome, message, callback = () => {}) {
  const success = outcome === 'success';
  chrome.notifications.create(`wps-edit-prototype-${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icon.svg'),
    title: success ? 'Document submitted' : 'Document submission failed',
    message: message || (success
      ? 'The server accepted the saved Document version.'
      : 'The saved version was not accepted; recovery is required.'),
    priority: 2
  }, callback);
}

function notificationProbe(request, sendResponse) {
  const success = request.outcome === 'success';
  setTimeout(() => {
    showNotification(request.outcome, '', () => sendResponse({
      version: 1,
      type: 'notification-shown',
      status: success ? 'completed' : 'failed',
      outcome: request.outcome,
      message: `A fixed ${request.outcome} notification was issued after the three-second foregrounding delay.`,
      extensionVersion: chrome.runtime.getManifest().version
    }));
  }, 3000);
}

function nativeRequest(request, sendResponse) {
  const port = chrome.runtime.connectNative(HOST);
  const startedAt = new Date().toISOString();
  let answered = false;

  port.onMessage.addListener((response) => {
    answered = true;
    const reply = {
      ...response,
      nativeChannelStartedAt: startedAt,
      nativeChannelEndedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime.getManifest().version
    };
    if (request.type === 'task-start') {
      if (response.status === 'completed' && response.outcome === 'submitted') {
        showNotification('success', 'The server accepted the saved Document version.');
      } else if (response.status === 'failed') {
        showNotification('failure', response.message);
      }
    }
    sendResponse(reply);
    port.disconnect();
  });

  port.onDisconnect.addListener(() => {
    if (answered) return;
    const reply = failed('native_host_unavailable', chrome.runtime.lastError?.message || 'The Native Messaging channel closed without a response.', request);
    if (request.type === 'task-start') showNotification('failure', reply.message);
    sendResponse({ ...reply, nativeChannelStartedAt: startedAt, nativeChannelEndedAt: new Date().toISOString() });
  });

  const nativeMessage = { ...request };
  delete nativeMessage.source;
  delete nativeMessage.outcome;
  port.postMessage(nativeMessage);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.kind !== 'page-request') return false;
  const request = message.request;
  const error = validate(request, sender);
  if (error) {
    sendResponse(error);
    return false;
  }
  if (request.type === 'notification-probe') notificationProbe(request, sendResponse);
  else nativeRequest(request, sendResponse);
  return true;
});
