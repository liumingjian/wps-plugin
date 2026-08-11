const documentName = document.querySelector('#document-name');
const documentVersion = document.querySelector('#document-version');
const documentPreview = document.querySelector('#document-preview');
const editEntry = document.querySelector('.edit-entry');
const status = document.querySelector('#task-status');

editEntry.disabled = true;

async function loadCurrentDocument() {
  const response = await fetch('/documents/doc-001', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load the current document (${response.status}).`);
  const current = await response.json();
  documentName.textContent = current.name;
  documentVersion.textContent = `Version ${current.version} · Updated ${new Date(current.updatedAt).toLocaleString()}`;
  documentPreview.textContent = current.previewText || 'This document has no previewable text.';
  return current;
}

function showFailure(error) {
  status.dataset.state = 'failed';
  status.textContent = error?.message || 'Local WPS Editing could not continue.';
  editEntry.disabled = false;
}

editEntry.addEventListener('click', async event => {
  editEntry.disabled = true;
  status.dataset.state = 'editing';
  status.textContent = 'Opening the current version in WPS.';
  try {
    const task = await window.WpsEdit.open({
      documentId: event.currentTarget.dataset.documentId,
      editingTasksUrl: '/editing-tasks',
      contractVersion: 1
    });
    const unsubscribe = task.subscribe(async taskEvent => {
      if (taskEvent.type === 'submission-accepted') {
        const current = await loadCurrentDocument();
        status.dataset.state = 'succeeded';
        status.textContent = `The server accepted version ${current.version}.`;
      } else if (taskEvent.type === 'attention-required') {
        status.dataset.state = 'failed';
        status.textContent = taskEvent.error?.message || 'The Snapshot is retained for recovery.';
      }
    });
    task.completion.then(async taskEvent => {
      unsubscribe();
      const current = await loadCurrentDocument();
      status.dataset.state = 'succeeded';
      status.textContent = taskEvent.outcome === 'unchanged'
        ? `WPS was closed without saving. Version ${current.version} is still current.`
        : `Version ${current.version} is current. You can edit it again in WPS.`;
      editEntry.disabled = false;
    }).catch(error => {
      unsubscribe();
      showFailure(error);
    });
  } catch (error) {
    showFailure(error);
  }
});

Promise.all([loadCurrentDocument(), window.WpsEdit.getReadiness()]).then(([, readiness]) => {
  if (readiness.state !== 'verified') {
    throw new Error(readiness.issues?.[0]?.message || 'Local WPS Editing Setup requires attention.');
  }
  status.dataset.state = 'succeeded';
  status.textContent = 'Ready to edit the current document.';
  editEntry.disabled = false;
}).catch(showFailure);
