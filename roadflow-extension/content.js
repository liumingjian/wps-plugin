'use strict';

let configuration;
const VERIFICATION_FAILURE_MESSAGE = 'Document verification failed. Editing was not opened.';
const EDITOR_TAB_FAILURE_MESSAGE = 'Unable to open a new editor tab. Allow pop-ups for the OA and try again.';
const VERIFICATION_RETRY_DELAYS_MS = [300, 700];
const HANDOFF_ID_PATTERN = /^[a-f0-9]{64}$/;
const DEBUG_PREFIX = '[RoadFlow WPS debug]';

function debugURL(value) {
  try {
    const parsed = value instanceof URL ? value : new URL(String(value));
    if (parsed.protocol === 'blob:') return `blob:${parsed.pathname}`;
    return `${parsed.origin}${parsed.pathname}${parsed.search ? '?[redacted]' : ''}${parsed.hash ? '#[redacted]' : ''}`;
  } catch {
    return typeof value === 'string' ? value : undefined;
  }
}

function debugError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function debug(event, details = {}) {
  if (!globalThis.chrome?.runtime?.id || typeof globalThis.console?.info !== 'function') return;
  console.info(`${DEBUG_PREFIX} ${event}`, details);
}

function extensionVersion() {
  try { return chrome.runtime.getManifest().version; } catch { return undefined; }
}

debug('content-script-loaded', {
  extensionId: chrome.runtime?.id,
  extensionVersion: extensionVersion(),
  pageURL: debugURL(location.href),
  pageOrigin: location.origin,
  readyState: globalThis.document?.readyState
});

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
  debug('editor-asset-request', { name });
  try {
    const response = await fetch(chrome.runtime.getURL(name));
    debug('editor-asset-response', { name, ok: response.ok, status: response.status });
    if (!response.ok) throw new Error(`Packaged editor asset is unavailable: ${name}`);
    return response.text();
  } catch (error) {
    debug('editor-asset-failed', { name, error: debugError(error) });
    throw error;
  }
}

function encodedUTF8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function deriveSourceIdentity(source, expectedFormat) {
  let result = await RoadFlowSourceIdentity.derive(source.href, expectedFormat);
  for (const delayMilliseconds of VERIFICATION_RETRY_DELAYS_MS) {
    if (result.ok) return result;
    debug('document-verification-retry', {
      sourceURL: debugURL(source),
      expectedFormat,
      delayMilliseconds
    });
    await delay(delayMilliseconds);
    result = await RoadFlowSourceIdentity.derive(source.href, expectedFormat);
  }
  return result;
}

function closeEditorTab(editorWindow) {
  try {
    if (editorWindow && !editorWindow.closed) editorWindow.close();
  } catch (error) {
    debug('editor-tab-close-failed', { error: debugError(error) });
  }
}

async function openHostedEditor(editorLaunch, editorWindow) {
  debug('editor-launch-start', {
    handoff: editorLaunch?.handoff,
    documentURL: debugURL(editorLaunch?.documentURL),
    officeSaveURL: debugURL(editorLaunch?.officeSaveURL),
    sourcePath: editorLaunch?.sourcePath
  });
  if (!HANDOFF_ID_PATTERN.test(editorLaunch?.handoff || '')) throw new Error('Editor Handoff is invalid.');
  const [html, css, javascript, formatCapabilities] = await Promise.all([
    packagedText('hosted-editor.html'),
    packagedText('hosted-editor.css'),
    packagedText('hosted-editor.js'),
    packagedText('format-capabilities.js')
  ]);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const stylesheet = parsed.querySelector('link[rel="stylesheet"]');
  const editorScript = parsed.querySelector('script[src$="editor.js"]') || parsed.querySelector('script[src]');
  if (!stylesheet || !editorScript) throw new Error('Packaged editor shell is invalid.');
  const style = parsed.createElement('style');
  style.textContent = css;
  stylesheet.replaceWith(style);
  const contextScript = parsed.createElement('script');
  contextScript.textContent = `globalThis.RoadFlowEditorContext=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${encodedUTF8(JSON.stringify(editorLaunch))}'),character=>character.charCodeAt(0))));`;
  const formatScript = parsed.querySelector('script[src$="format-capabilities.js"]') || parsed.createElement('script');
  formatScript.removeAttribute('src');
  formatScript.textContent = formatCapabilities;
  editorScript.before(formatScript);
  editorScript.before(contextScript);
  editorScript.removeAttribute('src');
  editorScript.textContent = javascript;
  const editorBlob = new Blob([`<!doctype html>${parsed.documentElement.outerHTML}`], { type: 'text/html' });
  const editorURL = URL.createObjectURL(editorBlob);
  debug('editor-blob-created', { size: editorBlob.size, type: editorBlob.type, editorURL });
  if (!editorWindow || editorWindow.closed) throw new Error('Editor tab is no longer available.');
  editorWindow.location.replace(editorURL);
}

debug('configuration-requested', { pageOrigin: location.origin });
chrome.runtime.sendMessage({ type: 'configuration' }).then(response => {
  if (response?.ok) configuration = response.configuration;
  debug('configuration-received', {
    ok: Boolean(response?.ok),
    trustedOrigin: response?.configuration?.trustedOrigin ?? undefined,
    pageOrigin: location.origin,
    pageTrusted: Boolean(response?.ok && trustedOriginMatches(location.origin, response.configuration))
  });
}).catch(error => {
  debug('configuration-request-failed', { error: debugError(error), pageOrigin: location.origin });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.roadFlowIntegration) return;
  const trustedOrigin = changes.roadFlowIntegration.newValue?.trustedOrigin;
  const nextConfiguration = { trustedOrigin };
  configuration = typeof trustedOrigin === 'string' && trustedOriginMatches(location.origin, nextConfiguration)
    ? nextConfiguration
    : undefined;
  debug('configuration-changed', {
    trustedOrigin: typeof trustedOrigin === 'string' ? trustedOrigin : undefined,
    pageOrigin: location.origin,
    pageTrusted: Boolean(configuration)
  });
});

async function enterPackagedEditor(source, title, editorWindow) {
  const capability = RoadFlowFormatCapabilities.forPath(source.pathname);
  if (!capability) throw new Error('Unsupported document format.');
  const expectedFormat = capability.format;
  debug('document-verification-start', {
    sourceURL: debugURL(source),
    sourcePath: source.pathname,
    expectedFormat
  });
  const identityResult = await deriveSourceIdentity(source, expectedFormat);
  if (!identityResult.ok) {
    debug('document-verification-failed', {
      sourceURL: debugURL(source),
      expectedFormat,
      message: identityResult.message
    });
    closeEditorTab(editorWindow);
    window.alert(identityResult.message);
    return;
  }
  debug('document-verification-succeeded', {
    sourceURL: debugURL(source),
    sourcePath: identityResult.identity.sourcePath,
    actualFormat: identityResult.identity.actualFormat,
    byteCount: identityResult.identity.byteCount,
    sha256: identityResult.identity.sha256
  });
  const activation = {
    returnURL: location.href,
    returnMode: 'close',
    sourceURL: source.href,
    title
  };
  activation.sourceIdentity = identityResult.identity;
  debug('editor-handoff-requested', {
    returnURL: debugURL(activation.returnURL),
    sourceURL: debugURL(activation.sourceURL),
    sourcePath: activation.sourceIdentity.sourcePath
  });
  const response = await chrome.runtime.sendMessage({
    type: 'create-editor-handoff',
    activation
  });
  debug('editor-handoff-response', {
    ok: Boolean(response?.ok),
    handoff: response?.editorLaunch?.handoff,
    documentURL: debugURL(response?.editorLaunch?.documentURL),
    officeSaveURL: debugURL(response?.editorLaunch?.officeSaveURL)
  });
  if (response?.ok && response.editorLaunch) {
    await openHostedEditor(response.editorLaunch, editorWindow);
  } else {
    closeEditorTab(editorWindow);
    window.alert(VERIFICATION_FAILURE_MESSAGE);
  }
}

window.addEventListener('click', event => {
  const anchor = event.target?.closest?.('a[href]');
  if (!anchor) return;

  const rawHref = anchor.getAttribute?.('href') || anchor.href || '';
  const absoluteHref = anchor.href || rawHref;
  const likelyDocument = RoadFlowFormatCapabilities.isLikelyPath(rawHref) ||
    RoadFlowFormatCapabilities.isLikelyPath(absoluteHref);
  if (!likelyDocument) return;

  let source;
  try {
    source = new URL(absoluteHref, location.href);
  } catch {
    debug('document-link-skipped', {
      reason: ['malformed-url'],
      rawHref,
      pageOrigin: location.origin
    });
    return;
  }

  debug('document-link-click-observed', {
    pageURL: debugURL(location.href),
    pageOrigin: location.origin,
    sourceURL: debugURL(source),
    rawHref,
    isTrusted: event.isTrusted,
    defaultPrevented: event.defaultPrevented,
    button: event.button,
    modifiers: {
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey
    },
    configurationLoaded: Boolean(configuration),
    trustedOrigin: configuration?.trustedOrigin
  });

  const reasons = [];
  if (!configuration) reasons.push('configuration-not-loaded');
  if (!event.isTrusted) reasons.push('untrusted-event');
  if (event.defaultPrevented) reasons.push('default-already-prevented');
  if (event.button !== 0) reasons.push('non-primary-button');
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) reasons.push('modifier-key');
  if (!trustedOriginMatches(location.origin)) reasons.push('page-origin-not-trusted');
  if (!trustedOriginMatches(source.origin)) reasons.push('source-origin-not-trusted');
  if (!/^https?:$/.test(source.protocol)) reasons.push('unsupported-protocol');
  if (!RoadFlowFormatCapabilities.forPath(source.pathname)) reasons.push('unsupported-extension');
  if (reasons.length > 0) {
    debug('document-link-skipped', {
      reasons,
      pageOrigin: location.origin,
      sourceURL: debugURL(source),
      sourcePath: source.pathname
    });
    return;
  }

  event.preventDefault();
  let editorWindow;
  try {
    editorWindow = window.open('about:blank', '_blank');
  } catch (error) {
    debug('editor-tab-open-failed', { error: debugError(error) });
  }
  if (!editorWindow) {
    debug('editor-tab-open-failed', { reason: 'popup-blocked' });
    window.alert(EDITOR_TAB_FAILURE_MESSAGE);
    return;
  }
  debug('editor-tab-opened', { pageURL: debugURL(location.href) });
  debug('document-link-intercepted', {
    sourceURL: debugURL(source),
    sourcePath: source.pathname,
    expectedFormat: RoadFlowFormatCapabilities.forPath(source.pathname)?.format
  });
  void enterPackagedEditor(source, anchor.textContent.trim(), editorWindow)
    .catch(error => {
      closeEditorTab(editorWindow);
      debug('editor-launch-failed', { sourceURL: debugURL(source), error: debugError(error) });
      window.alert(VERIFICATION_FAILURE_MESSAGE);
    });
}, false);
