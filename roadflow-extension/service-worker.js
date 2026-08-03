'use strict';

importScripts('configuration.js', 'source-identity-contract.js');

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function configuredIntegration() {
  const stored = await chrome.storage.local.get(RoadFlowConfiguration.STORAGE_KEY);
  const result = RoadFlowConfiguration.validate(stored[RoadFlowConfiguration.STORAGE_KEY]);
  return result.ok ? result.value : undefined;
}

function senderOrigin(sender) {
  try { return new URL(sender?.url).origin; } catch { return undefined; }
}

async function configurationFor(sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !sender?.tab || senderOrigin(sender) !== configuration.trustedOrigin) return { ok: false };
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
      senderOrigin(sender) !== configuration.trustedOrigin) return { ok: false };

  let source;
  try { source = new URL(activation.sourceURL); } catch { return { ok: false }; }
  const sourcePath = RoadFlowSourceIdentityContract.sourcePath(source);
  if (!sourcePath || source.origin !== configuration.trustedOrigin || !/\.docx?$/i.test(sourcePath)) {
    return { ok: false };
  }
  const expectedFormat = /\.docx$/i.test(sourcePath) ? 'docx' : 'doc';
  const sourceIdentity = RoadFlowSourceIdentityContract.validate(
    activation.sourceIdentity, sourcePath, expectedFormat
  );
  if (!sourceIdentity) return { ok: false };

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
      trustedOrigin: configuration.trustedOrigin,
      sourceURL: source.href,
      sourcePath,
      title,
      expectedFormat,
      sourceIdentity
    })
  };
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (request?.type === 'configuration') {
    configurationFor(sender).then(respond).catch(() => respond({ ok: false }));
    return true;
  }
  if (request?.type === 'create-editor-handoff') {
    createEditorHandoff(request.activation, sender).then(respond).catch(() => respond({ ok: false }));
    return true;
  }
  if (request?.type !== 'apply-configuration') return false;
  if (sender.url !== chrome.runtime.getURL('options.html')) {
    respond({ ok: false, message: 'Configuration request was not authorized.' });
    return false;
  }

  const result = RoadFlowConfiguration.validate(request.configuration);
  if (!result.ok) {
    respond(result);
    return false;
  }
  const matches = RoadFlowConfiguration.permissionPatterns(result.value);
  chrome.permissions.contains({ origins: matches }).then(async granted => {
    if (!granted) {
      respond({ ok: false, message: 'Trusted OA Origin access was not granted.' });
      return;
    }
    await chrome.storage.local.set({ [RoadFlowConfiguration.STORAGE_KEY]: result.value });
    respond({ ok: true, configuration: result.value });
  }).catch(() => respond({ ok: false, message: 'Configuration could not be applied.' }));
  return true;
});
