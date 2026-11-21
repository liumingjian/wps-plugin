'use strict';

let configuration;
const VERIFICATION_FAILURE_MESSAGE = '正文验证失败，未开放编辑。';
let enteringEditor = false;

function showVerificationProgress(anchor) {
  if (typeof document === 'undefined') return undefined;
  const progress = document.createElement('span');
  progress.textContent = '正在验证正文…';
  progress.setAttribute('role', 'status');
  if (anchor) anchor.insertAdjacentElement('afterend', progress);
  else document.body.append(progress);
  return progress;
}

async function deriveSource(sourceURL, expectedFormat) {
  let timeout;
  try {
    return await Promise.race([
      RoadFlowSourceIdentity.derive(sourceURL, expectedFormat),
      new Promise(resolve => { timeout = setTimeout(() => resolve({ ok: false }), 30_000); })
    ]);
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function resumeReverification() {
  const claim = await chrome.runtime.sendMessage({ type: 'claim-reverification' });
  if (!claim?.ok) return;
  enteringEditor = true;
  const progress = showVerificationProgress();
  try {
    const identityResult = await deriveSource(claim.sourceURL, claim.expectedFormat);
    const completed = await chrome.runtime.sendMessage({
      type: 'complete-reverification-handoff',
      handoffID: claim.handoffID,
      ...(identityResult.ok ? { sourceIdentity: identityResult.identity } : { sourceVerificationFailed: true })
    });
    if (completed?.ok) location.replace(completed.editorURL);
    else window.alert(VERIFICATION_FAILURE_MESSAGE);
  } finally {
    enteringEditor = false;
    progress?.remove();
  }
}

chrome.runtime.sendMessage({ type: 'configuration' }).then(response => {
  if (response?.ok) configuration = response.configuration;
  return resumeReverification();
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.roadFlowIntegration) return;
  const trustedOrigin = changes.roadFlowIntegration.newValue?.trustedOrigin;
  configuration = trustedOrigin === location.origin ? { trustedOrigin } : undefined;
});

async function enterPackagedEditor(source, title) {
  const returnURL = location.href;
  const expectedFormat = /\.docx$/i.test(source.pathname) ? 'docx' : 'doc';
  const identityResult = await deriveSource(source.href, expectedFormat);
  const activation = {
    returnURL,
    sourceURL: source.href,
    title
  };
  if (identityResult.ok) activation.sourceIdentity = identityResult.identity;
  else activation.sourceVerificationFailed = true;
  const response = await chrome.runtime.sendMessage({
    type: 'create-editor-handoff',
    activation
  });
  if (response?.ok) {
    location.replace(response.editorURL);
  } else {
    window.alert(VERIFICATION_FAILURE_MESSAGE);
  }
}

window.addEventListener('click', event => {
  if (!configuration || !event.isTrusted || event.defaultPrevented || event.button !== 0 ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  const anchor = event.target?.closest?.('a[href]');
  if (!anchor) return;

  let source;
  try {
    source = new URL(anchor.href, location.href);
  } catch {
    return;
  }
  if (location.origin !== configuration.trustedOrigin ||
      source.origin !== configuration.trustedOrigin ||
      !/^https?:$/.test(source.protocol) ||
      !/\.docx?$/i.test(source.pathname)) return;

  event.preventDefault();
  if (enteringEditor) return;
  enteringEditor = true;
  const progress = showVerificationProgress(anchor);
  void enterPackagedEditor(source, anchor.textContent.trim())
    .catch(() => window.alert(VERIFICATION_FAILURE_MESSAGE))
    .finally(() => { enteringEditor = false; progress?.remove(); });
}, false);
