'use strict';

importScripts('configuration.js', 'source-identity-contract.js');

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
  if (typeof globalThis.console?.info !== 'function') return;
  console.info(`${DEBUG_PREFIX} ${event}`, details);
}

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function configuredIntegration() {
  const stored = await chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY);
  const result = RoadFlowConfiguration.validate(stored[RoadFlowConfiguration.STORAGE_KEY]);
  debug('worker-configuration-read', {
    valid: result.ok,
    trustedOrigin: result.ok ? result.value.trustedOrigin : undefined
  });
  return result.ok ? result.value : undefined;
}

function senderOrigin(sender) {
  try { return new URL(sender?.url).origin; } catch { return undefined; }
}

async function configurationFor(sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !sender?.tab || !RoadFlowConfiguration.trustsOrigin(configuration, senderOrigin(sender))) {
    return { ok: false };
  }
  return { ok: true, configuration };
}

function editorLaunch(handoff, context) {
  const officeSaveURL = new URL('/RoadFlow/uploadfiles/OfficeSave', context.trustedOrigin);
  officeSaveURL.searchParams.set('fileurl', context.sourcePath);
  const documentURL = new URL(context.sourceURL);
  // WPS caches opened Documents by URL. A fragment changes that cache key but is
  // never sent to the OA server, so the original download endpoint is unchanged.
  documentURL.hash = `roadflow-handoff=${handoff}`;
  return Object.freeze({
    documentURL: documentURL.href,
    expectedFormat: context.expectedFormat,
    handoff,
    officeSaveURL: officeSaveURL.href,
    returnURL: context.returnURL,
    sourceIdentity: context.sourceIdentity,
    sourcePath: context.sourcePath,
    title: context.title
  });
}

async function createEditorHandoff(activation, sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !sender?.tab || sender.url !== activation?.returnURL ||
      !RoadFlowConfiguration.trustsOrigin(configuration, senderOrigin(sender))) return { ok: false };

  let source;
  try { source = new URL(activation.sourceURL); } catch { return { ok: false }; }
  const sourcePath = RoadFlowSourceIdentityContract.sourcePath(source);
  if (!sourcePath || !RoadFlowConfiguration.trustsOrigin(configuration, source.origin) ||
      !/^https?:$/.test(source.protocol) || !/\.docx?$/i.test(sourcePath)) {
    return { ok: false };
  }
  const expectedFormat = /\.docx$/i.test(sourcePath) ? 'docx' : 'doc';
  const sourceIdentity = RoadFlowSourceIdentityContract.validate(
    activation.sourceIdentity, sourcePath, expectedFormat
  );
  if (!sourceIdentity) return { ok: false };

  // In all-origin mode the OA page remains the owner of its OfficeSave endpoint.
  const trustedOrigin = configuration.trustedOrigin || senderOrigin(sender);

  const encodedFilename = source.pathname.slice(source.pathname.lastIndexOf('/') + 1);
  let filename = encodedFilename;
  try { filename = decodeURIComponent(encodedFilename); } catch {}
  const title = typeof activation.title === 'string' && activation.title.trim()
    ? activation.title.trim().slice(0, 256)
    : filename;
  const handoff = randomHex(32);
  return {
    ok: true,
    editorLaunch: editorLaunch(handoff, {
      returnURL: sender.url,
      trustedOrigin,
      sourceURL: source.href,
      sourcePath,
      title,
      expectedFormat,
      sourceIdentity
    })
  };
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  debug('worker-message-received', {
    type: request?.type,
    senderURL: debugURL(sender?.url),
    senderTabId: sender?.tab?.id
  });
  if (request?.type === 'configuration') {
    configurationFor(sender).then(result => {
      debug('worker-configuration-response', {
        ok: Boolean(result?.ok),
        trustedOrigin: result?.configuration?.trustedOrigin,
        senderURL: debugURL(sender?.url)
      });
      respond(result);
    }).catch(error => {
      debug('worker-configuration-failed', { error: debugError(error) });
      respond({ ok: false });
    });
    return true;
  }
  if (request?.type === 'create-editor-handoff') {
    debug('worker-handoff-request', {
      senderURL: debugURL(sender?.url),
      returnURL: debugURL(request.activation?.returnURL),
      sourceURL: debugURL(request.activation?.sourceURL),
      sourcePath: request.activation?.sourceIdentity?.sourcePath
    });
    createEditorHandoff(request.activation, sender).then(result => {
      debug('worker-handoff-response', {
        ok: Boolean(result?.ok),
        handoff: result?.editorLaunch?.handoff,
        documentURL: debugURL(result?.editorLaunch?.documentURL),
        officeSaveURL: debugURL(result?.editorLaunch?.officeSaveURL)
      });
      respond(result);
    }).catch(error => {
      debug('worker-handoff-failed', { error: debugError(error) });
      respond({ ok: false });
    });
    return true;
  }
  if (request?.type !== 'apply-configuration') return false;
  if (sender.url !== chrome.runtime.getURL('options.html')) {
    debug('worker-configuration-rejected', { reason: 'unauthorized-sender', senderURL: debugURL(sender?.url) });
    respond({ ok: false, message: 'Configuration request was not authorized.' });
    return false;
  }

  const result = RoadFlowConfiguration.validate(request.configuration);
  if (!result.ok) {
    debug('worker-configuration-rejected', { reason: 'invalid-configuration', message: result.message });
    respond(result);
    return false;
  }
  const matches = RoadFlowConfiguration.permissionPatterns(result.value);
  debug('worker-configuration-permission-check', {
    trustedOrigin: result.value.trustedOrigin,
    requestedPatterns: matches
  });
  chrome.permissions.contains({ origins: matches }).then(async granted => {
    if (!granted) {
      debug('worker-configuration-rejected', { reason: 'permission-not-granted', requestedPatterns: matches });
      respond({ ok: false, message: 'Trusted OA Origin access was not granted.' });
      return;
    }
    await chrome.storage.local.set({ [RoadFlowConfiguration.STORAGE_KEY]: result.value });
    debug('worker-configuration-saved', { trustedOrigin: result.value.trustedOrigin });
    respond({ ok: true, configuration: result.value });
  }).catch(error => {
    debug('worker-configuration-failed', { error: debugError(error) });
    respond({ ok: false, message: 'Configuration could not be applied.' });
  });
  return true;
});
