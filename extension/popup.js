const stateLabel = document.querySelector('#state');
const originLabel = document.querySelector('#origin-label');
const approve = document.querySelector('#approve');
const taskSection = document.querySelector('#task');
const taskStatus = document.querySelector('#task-status');
const actions = document.querySelector('#actions');
const notificationError = document.querySelector('#notification-error');

function commandButton(label, command, secondary = false) {
  const button = document.createElement('button');
  button.textContent = label;
  if (secondary) button.className = 'secondary';
  button.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'task-command', taskId: taskSection.dataset.taskId, command }));
  return button;
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let origin;
  try { origin = new URL(tab.url).origin; } catch { origin = ''; }
  const data = await chrome.runtime.sendMessage({ type: 'popup-state' });
  const trusted = data.origins.includes(origin);
  stateLabel.textContent = trusted ? 'Origin approved' : 'Action required';
  originLabel.textContent = trusted ? origin : 'Approve this OA Origin before starting an Editing Task.';
  approve.hidden = trusted || !origin;
  notificationError.hidden = !data.notificationError;
  if (!data.activeTask) return;
  const { taskId, event } = data.activeTask;
  taskSection.hidden = false;
  taskSection.dataset.taskId = taskId;
  taskStatus.textContent = event.type.replaceAll('-', ' ');
  actions.replaceChildren();
  if (event.type === 'attention-required') {
    actions.append(commandButton('Retry now', 'retry-now'));
    if (event.error?.code === 'TASK_INTERRUPTED') {
      actions.append(commandButton('Continue editing', 'continue', true), commandButton('End editing', 'end', true));
    }
  }
  actions.append(commandButton('Export diagnostics', 'export-diagnostics', true));
}

approve.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'trust-origin' });
  await render();
});
render();
