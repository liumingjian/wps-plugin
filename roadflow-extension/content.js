'use strict';

let configuration;
const VERIFICATION_FAILURE_MESSAGE = 'Document verification failed. Editing was not opened.';
const HANDOFF_ID_PATTERN = /^[a-f0-9]{64}$/;

function trustedOriginMatches(origin, candidateConfiguration = configuration) {
  if (!candidateConfiguration || typeof origin !== 'string') return false;
  if (candidateConfiguration.trustedOrigin) return origin === candidateConfiguration.trustedOrigin;
  try {
    return ['http:', 'https:'].includes(new URL(origin).protocol);
  } catch {
    return false;
  }
}

async function packagedText(name) {
  const response = await fetch(chrome.runtime.getURL(name));
  if (!response.ok) throw new Error(`Packaged editor asset is unavailable: ${name}`);
  return response.text();
}

function encodedUTF8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function openHostedEditor(editorLaunch) {
  if (!HANDOFF_ID_PATTERN.test(editorLaunch?.handoff || '')) throw new Error('Editor Handoff is invalid.');
  const [html, css, javascript] = await Promise.all([
    packagedText('hosted-editor.html'),
    packagedText('hosted-editor.css'),
    packagedText('hosted-editor.js')
  ]);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const stylesheet = parsed.querySelector('link[rel="stylesheet"]');
  const editorScript = parsed.querySelector('script[src]');
  if (!stylesheet || !editorScript) throw new Error('Packaged editor shell is invalid.');
  const style = parsed.createElement('style');
  style.textContent = css;
  stylesheet.replaceWith(style);
  const contextScript = parsed.createElement('script');
  contextScript.textContent = `globalThis.RoadFlowEditorContext=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodedUTF8(JSON.stringify(editorLaunch))}'),character=>character.charCodeAt(0))));`;
  editorScript.before(contextScript);
  editorScript.removeAttribute('src');
  editorScript.textContent = javascript;
  const editorBlob = new Blob([`<!doctype html>${parsed.documentElement.outerHTML}`], { type: 'text/html' });
  location.replace(URL.createObjectURL(editorBlob));
}

chrome.runtime.sendMessage({ type: 'configuration' }).then(response => {
  if (response?.ok) configuration = response.configuration;
}).catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.roadFlowIntegration) return;
  const trustedOrigin = changes.roadFlowIntegration.newValue?.trustedOrigin;
  const nextConfiguration = { trustedOrigin };
  configuration = typeof trustedOrigin === 'string' && trustedOriginMatches(location.origin, nextConfiguration)
    ? nextConfiguration
    : undefined;
});

async function enterPackagedEditor(source, title) {
  const expectedFormat = /\.docx$/i.test(source.pathname) ? 'docx' : 'doc';
  const identityResult = await RoadFlowSourceIdentity.derive(source.href, expectedFormat);
  if (!identityResult.ok) {
    window.alert(identityResult.message);
    return;
  }
  const activation = {
    returnURL: location.href,
    sourceURL: source.href,
    title
  };
  activation.sourceIdentity = identityResult.identity;
  const response = await chrome.runtime.sendMessage({
    type: 'create-editor-handoff',
    activation
  });
  if (response?.ok && response.editorLaunch) {
    await openHostedEditor(response.editorLaunch);
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
  if (!trustedOriginMatches(location.origin) ||
      !trustedOriginMatches(source.origin) ||
      !/^https?:$/.test(source.protocol) ||
      !/\.docx?$/i.test(source.pathname)) return;

  event.preventDefault();
  void enterPackagedEditor(source, anchor.textContent.trim())
    .catch(() => window.alert(VERIFICATION_FAILURE_MESSAGE));
}, false);
