const status = document.querySelector('#task-status');

document.querySelector('.edit-entry').addEventListener('click', (event) => {
  const documentId = event.currentTarget.dataset.documentId;
  const taskId = `task-${documentId}`;
  status.dataset.state = 'connected';
  status.textContent = `Editing Task ${taskId}: connected to the extension.`;

  window.postMessage({
    source: 'wps-edit-demo',
    version: 1,
    type: 'task-start',
    taskId,
    documentId,
    downloadUrl: `${window.location.origin}/documents/${documentId}/content`,
    uploadUrl: `${window.location.origin}/tasks/${taskId}/submissions`
  }, window.location.origin);
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== 'wps-edit-extension') return;
  const reply = event.data;
  status.dataset.state = reply.status === 'accepted' ? 'accepted' : 'failed';
  const stage = reply.stage ? ` [${reply.stage}]` : '';
  status.textContent = `Editing Task ${reply.taskId || 'unknown'}${stage}: ${reply.message || 'The local agent returned no message.'}`;
});
