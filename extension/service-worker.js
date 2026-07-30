const HOST = 'com.liumingjian.wps_edit_agent';
const CONTRACT_VERSION = 1;
const NATIVE_PROTOCOL = 2;
const pagePorts = new Map();
const nativePorts = new Map();

function error(code, phase, disposition, message, action) {
  return { code, phase, disposition, message, ...(action ? { action } : {}) };
}

function actualOrigin(sender) {
  try {
    const url = new URL(sender.url);
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

async function trustedOrigins() {
  return (await chrome.storage.local.get('trustedOrigins')).trustedOrigins || [];
}

async function getReadiness() {
  const base = {
    state: 'action-required',
    contractVersions: [CONTRACT_VERSION],
    submissionProfiles: ['raw-body-v1', 'named-file-v1'],
    capabilities: ['durable-events', 'fifo-snapshots', 'recovery', 'notifications'],
    extensionVersion: chrome.runtime.getManifest().version,
    issues: []
  };
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(HOST, { protocolVersion: NATIVE_PROTOCOL, type: 'get-readiness' }, response => {
      if (chrome.runtime.lastError || !response) {
        resolve({ ...base, state: 'unavailable', issues: [error('AGENT_UNAVAILABLE', 'open', 'user-action', 'Local WPS Editing Setup is required.', 'open-setup')] });
        return;
      }
      if (response.protocolVersion !== NATIVE_PROTOCOL) {
        resolve({ ...base, state: 'incompatible', agentVersion: response.agentVersion, issues: [error('UNSUPPORTED_CONTRACT', 'open', 'user-action', 'The extension and local agent versions are incompatible.', 'repair')] });
        return;
      }
      resolve({ ...base, ...response.readiness, agentVersion: response.agentVersion });
    });
  });
}

async function normalizedDescriptor(origin, input) {
  const taskURL = new URL(input.editingTasksUrl);
  if (taskURL.origin !== origin || input.contractVersion !== CONTRACT_VERSION) {
    throw error('INVALID_TASK', 'create', 'terminal', 'The Editing Task request is not same-Origin contract version 1.');
  }
  let url = taskURL.href;
  let options;
  if (input.documentId) {
    options = {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contractVersion: CONTRACT_VERSION, documentId: input.documentId, idempotencyKey: crypto.randomUUID() })
    };
  } else {
    url = `${taskURL.href.replace(/\/$/, '')}/${encodeURIComponent(input.taskId)}/capabilities`;
    options = { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' };
  }
  const response = await fetch(url, options);
  if (response.status === 401 || response.status === 403) throw error('AUTHENTICATION_REQUIRED', 'create', 'user-action', 'Return to OA to authorize this Editing Task.', 'reauthorize');
  if (!response.ok) throw error('INVALID_TASK', 'create', 'terminal', `The OA server rejected the Editing Task (HTTP ${response.status}).`);
  const descriptor = await response.json();
  if (descriptor.contractVersion !== CONTRACT_VERSION || typeof descriptor.taskId !== 'string') throw error('INVALID_TASK', 'create', 'terminal', 'The OA server returned an invalid Editing Task descriptor.');
  return descriptor;
}

function notificationFor(event) {
  if (event.type === 'submission-accepted') return { kind: 'accepted', title: 'Document version submitted', message: `The server accepted version ${event.snapshotSequence}.` };
  if (event.type !== 'attention-required') return null;
  if (event.error?.code === 'AUTHENTICATION_REQUIRED' || event.error?.code === 'CAPABILITY_EXPIRED') return { kind: 'authorization', title: 'Return to OA to continue submission', message: 'Reauthorize the current editing task.' };
  if (event.error?.disposition === 'automatic-retry') return { kind: 'delayed', title: 'Document submission delayed', message: 'The local copy is safe; retrying will continue.' };
  return { kind: 'recovery', title: 'Document not yet submitted', message: 'The local copy is safe; open diagnostics or return to OA.' };
}

async function showEventNotification(event) {
  if (event.replayed) return;
  const notice = notificationFor(event);
  if (!notice) return;
  const id = `local-wps-editing:${event.taskId}:${event.snapshotSequence || 0}:${notice.kind}`;
  await new Promise((resolve, reject) => {
    chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title: notice.title, message: notice.message, priority: 2 }, notificationId => {
      const failure = chrome.runtime.lastError?.message;
      if (failure) reject(new Error(failure));
      else resolve(notificationId);
    });
  });
}

function connectTask(pagePort, descriptor) {
  const taskId = descriptor.taskId;
  const requestId = descriptor.requestId;
  const native = chrome.runtime.connectNative(HOST);
  let recoverable = false;
  let completed = false;
  nativePorts.set(taskId, native);
  native.onMessage.addListener(message => {
    if (message.type === 'task-accepted') pagePort.postMessage({ requestId, status: 'accepted', taskId });
    if (message.type === 'error') {
      completed = true;
      pagePort.postMessage({ requestId, status: 'failed', error: error(message.code || 'INTERNAL_ERROR', 'open', 'terminal', message.message || 'The local agent rejected the Editing Task.') });
    }
    if (message.type === 'task-paused') recoverable = true;
    if (message.event) {
      recoverable = message.event.type === 'attention-required';
      completed = message.event.type === 'task-completed' || message.event.type === 'task-failed';
      pagePort.postMessage({ taskId, event: message.event });
      chrome.storage.local.set({ activeTask: { taskId, event: message.event } });
      showEventNotification(message.event).catch(notificationError => chrome.storage.local.set({ notificationError: String(notificationError) }));
    }
  });
  native.onDisconnect.addListener(() => {
    nativePorts.delete(taskId);
    if (chrome.runtime.lastError && !recoverable && !completed) pagePort.postMessage({ taskId, event: { type: 'task-failed', taskId, eventSequence: Number.MAX_SAFE_INTEGER, error: error('AGENT_UNAVAILABLE', 'open', 'user-action', 'The local agent connection ended.', 'repair') } });
  });
  const message = { protocolVersion: NATIVE_PROTOCOL, type: descriptor.resume ? 'task-resume' : 'task-open', descriptor };
  delete message.descriptor.requestId;
  delete message.descriptor.resume;
  native.postMessage(message);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'page-sdk') return;
  const origin = actualOrigin(port.sender);
  if (!origin) return port.disconnect();
  pagePorts.set(port.sender.documentId || port.sender.tab?.id, port);
  port.onMessage.addListener(async request => {
    if (request?.kind !== 'page-request') return;
    try {
      if (request.operation === 'get-readiness') {
        port.postMessage({ requestId: request.requestId, status: 'completed', readiness: await getReadiness() });
        return;
      }
      if (!request.userActivation && !request.input?.taskId) throw error('INVALID_TASK', 'create', 'user-action', 'Start editing from an explicit user action.');
      if (!(await trustedOrigins()).includes(origin)) throw error('ORIGIN_NOT_TRUSTED', 'create', 'user-action', 'Approve this OA Origin in Local WPS Editing.', 'approve-origin');
      const descriptor = await normalizedDescriptor(origin, request.input);
      descriptor.requestId = request.requestId;
      descriptor.resume = Boolean(request.input.taskId);
      connectTask(port, descriptor);
    } catch (failure) {
      port.postMessage({ requestId: request.requestId, status: 'failed', error: failure.code ? failure : error('INTERNAL_ERROR', 'create', 'terminal', 'Local WPS Editing could not create the task.') });
    }
  });
  port.onDisconnect.addListener(() => pagePorts.delete(port.sender.documentId || port.sender.tab?.id));
});

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.type === 'popup-state') {
    Promise.all([trustedOrigins(), chrome.storage.local.get(['activeTask', 'notificationError'])]).then(([origins, state]) => respond({ origins, ...state }));
    return true;
  }
  if (request?.type === 'trust-origin') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async tabs => {
      const origin = actualOrigin({ url: tabs[0]?.url });
      if (!origin) return respond({ ok: false });
      const origins = [...new Set([...(await trustedOrigins()), origin])];
      await chrome.storage.local.set({ trustedOrigins: origins });
      respond({ ok: true, origin });
    });
    return true;
  }
  if (request?.type === 'task-command' && typeof request.taskId === 'string') {
    const native = nativePorts.get(request.taskId) || chrome.runtime.connectNative(HOST);
    native.postMessage({ protocolVersion: NATIVE_PROTOCOL, type: 'task-command', taskId: request.taskId, command: request.command });
    respond({ ok: true });
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  chrome.runtime.sendNativeMessage(HOST, { protocolVersion: NATIVE_PROTOCOL, type: 'recover-tasks' }, () => void chrome.runtime.lastError);
});
