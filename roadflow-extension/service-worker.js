'use strict';

importScripts('configuration.js', 'source-identity-contract.js');

const HANDOFF_STORAGE_KEY = 'editorHandoffs';
const HANDOFF_TTL_MS = 120_000;
const HANDOFF_ID_PATTERN = /^[a-f0-9]{64}$/;
let handoffOperation = Promise.resolve();

function serializedHandoffOperation(operation) {
  const result = handoffOperation.then(operation, operation);
  handoffOperation = result.catch(() => {});
  return result;
}

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
  try {
    return new URL(sender?.url).origin;
  } catch {
    return undefined;
  }
}

async function configurationFor(sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !sender?.tab || senderOrigin(sender) !== configuration.trustedOrigin) return { ok: false };
  return { ok: true, configuration };
}

function editorSender(sender) {
  try {
    const senderURL = new URL(sender?.url);
    const editorURL = new URL(chrome.runtime.getURL('editor.html'));
    return senderURL.protocol === editorURL.protocol && senderURL.host === editorURL.host &&
      senderURL.pathname === editorURL.pathname;
  } catch {
    return false;
  }
}

async function createEditorHandoff(activation, sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !sender?.tab || sender.url !== activation?.returnURL ||
      senderOrigin(sender) !== configuration.trustedOrigin) return { ok: false };

  let source;
  try {
    source = new URL(activation.sourceURL);
  } catch {
    return { ok: false };
  }
  const sourcePath = source.pathname;
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password ||
      source.origin !== configuration.trustedOrigin || !/\.docx?$/i.test(sourcePath)) return { ok: false };

  const encodedFilename = sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
  let filename = encodedFilename;
  try { filename = decodeURIComponent(encodedFilename); } catch {}
  const title = typeof activation.title === 'string' && activation.title.trim()
    ? activation.title.trim().slice(0, 256)
    : filename;
  const expectedFormat = /\.docx$/i.test(sourcePath) ? 'docx' : 'doc';
  const sourceIdentity = expectedFormat === 'docx'
    ? RoadFlowSourceIdentityContract.validate(activation.sourceIdentity, sourcePath, expectedFormat)
    : undefined;
  if (expectedFormat === 'docx' && !sourceIdentity) return { ok: false };
  const createdAt = Date.now();
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY);
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    for (const [id, handoff] of Object.entries(handoffs)) {
      if (!handoff || handoff.expiresAt <= createdAt) delete handoffs[id];
    }
    let handoffID;
    do { handoffID = randomHex(32); } while (handoffs[handoffID]);
    handoffs[handoffID] = {
      returnURL: sender.url,
      trustedOrigin: configuration.trustedOrigin,
      sourceURL: source.href,
      sourcePath,
      title,
      filename,
      expectedFormat,
      ...(sourceIdentity ? { sourceIdentity } : {}),
      cacheIdentity: randomHex(16),
      createdAt,
      expiresAt: createdAt + HANDOFF_TTL_MS
    };
    await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
    const editorURL = new URL(chrome.runtime.getURL('editor.html'));
    editorURL.searchParams.set('handoff', handoffID);
    return { ok: true, editorURL: editorURL.href };
  });
}

function consumeEditorHandoff(handoffID, sender) {
  if (!editorSender(sender) || !HANDOFF_ID_PATTERN.test(handoffID || '')) return Promise.resolve({ ok: false });
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY);
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    const handoff = handoffs[handoffID];
    delete handoffs[handoffID];
    await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
    if (!handoff || handoff.expiresAt <= Date.now()) return { ok: false };
    return { ok: true, handoff };
  });
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
  if (request?.type === 'consume-editor-handoff') {
    consumeEditorHandoff(request.handoffID, sender).then(respond).catch(() => respond({ ok: false }));
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
  const matches = [RoadFlowConfiguration.originPattern(result.value.trustedOrigin)];
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
