'use strict';

let configuration;
const VERIFICATION_FAILURE_MESSAGE = 'Document verification failed. Editing was not opened.';

chrome.runtime.sendMessage({ type: 'configuration' }).then(response => {
  if (response?.ok) configuration = response.configuration;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.roadFlowIntegration) return;
  const trustedOrigin = changes.roadFlowIntegration.newValue?.trustedOrigin;
  configuration = trustedOrigin === location.origin ? { trustedOrigin } : undefined;
});

async function enterPackagedEditor(source, title) {
  const expectedFormat = /\.docx$/i.test(source.pathname) ? 'docx' : 'doc';
  let sourceIdentity;
  if (expectedFormat === 'docx') {
    const identityResult = await RoadFlowSourceIdentity.derive(source.href, expectedFormat);
    if (!identityResult.ok) {
      window.alert(identityResult.message);
      return;
    }
    sourceIdentity = identityResult.identity;
  } else {
    const response = await fetch(source.href, {
      cache: 'no-store',
      credentials: 'include',
      redirect: 'manual'
    });
    if (response.redirected || response.type === 'opaqueredirect' ||
        (response.status >= 300 && response.status < 400)) {
      try { await response.body?.cancel(); } catch {}
      location.assign(source.href);
      return;
    }
  }
  const activation = {
    returnURL: location.href,
    sourceURL: source.href,
    title
  };
  if (sourceIdentity) activation.sourceIdentity = sourceIdentity;
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
  void enterPackagedEditor(source, anchor.textContent.trim())
    .catch(() => window.alert(VERIFICATION_FAILURE_MESSAGE));
}, false);
