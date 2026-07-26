const documentName = document.querySelector('#document-name');
const documentVersion = document.querySelector('#document-version');
const documentPreview = document.querySelector('#document-preview');
const editEntry = document.querySelector('.edit-entry');
const status = document.querySelector('#task-status');
let activeTaskId = null;

async function loadCurrentDocument() {
  const response = await fetch('/documents/doc-001', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load the current document (${response.status}).`);
  const current = await response.json();
  documentName.textContent = current.name;
  documentVersion.textContent = `Version ${current.version} · Updated ${new Date(current.updatedAt).toLocaleString()}`;
  documentPreview.textContent = current.previewText || 'This document has no previewable text.';
  return current;
}

function newTaskId(documentId) {
  const suffix = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `edit-${documentId}-${suffix}`;
}

editEntry.addEventListener('click', (event) => {
  const documentId = event.currentTarget.dataset.documentId;
  activeTaskId = newTaskId(documentId);
  editEntry.disabled = true;
  status.dataset.state = 'editing';
  status.textContent = 'Opening the current version in WPS. Save in WPS to update this page.';

  window.postMessage({
    source: 'wps-edit-demo',
    version: 1,
    type: 'task-start',
    taskId: activeTaskId,
    documentId,
    downloadUrl: `${window.location.origin}/documents/${documentId}/content`,
    uploadUrl: `${window.location.origin}/documents/${documentId}/submissions`
  }, window.location.origin);
});

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== window.location.origin || event.data?.source !== 'wps-edit-extension') return;
  const reply = event.data;
  if (reply.taskId !== activeTaskId) return;

  if (reply.status === 'completed' && (reply.outcome === 'submitted' || reply.outcome === 'unchanged')) {
    try {
      const current = await loadCurrentDocument();
      if (reply.outcome === 'unchanged') {
        status.dataset.state = 'succeeded';
        status.textContent = `WPS was closed without saving. Version ${current.version} is still current.`;
      } else {
        status.dataset.state = 'succeeded';
        status.textContent = `Version ${current.version} is current. You can edit it again in WPS.`;
      }
    } catch (error) {
      status.dataset.state = 'failed';
      status.textContent = error.message;
    }
  } else {
    status.dataset.state = 'failed';
    status.textContent = reply.message || 'The local agent could not update the document.';
  }
  activeTaskId = null;
  editEntry.disabled = false;
});

loadCurrentDocument().catch((error) => {
  status.dataset.state = 'failed';
  status.textContent = error.message;
  editEntry.disabled = true;
});
