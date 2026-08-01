'use strict';

let configuration;

chrome.runtime.sendMessage({ type: 'configuration' }).then(response => {
  if (response?.ok) configuration = response.configuration;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.roadFlowIntegration) return;
  const trustedOrigin = changes.roadFlowIntegration.newValue?.trustedOrigin;
  configuration = trustedOrigin === location.origin ? { trustedOrigin } : undefined;
});

document.addEventListener('click', event => {
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
  chrome.runtime.sendMessage({
    type: 'create-editor-handoff',
    activation: {
      returnURL: location.href,
      sourceURL: source.href,
      title: anchor.textContent.trim()
    }
  }).then(response => {
    if (response?.ok) location.replace(response.editorURL);
  });
}, true);
