'use strict';

importScripts('configuration.js', 'source-identity-contract.js');

const HANDOFF_STORAGE_KEY = 'editorHandoffs';
const EDITOR_CONTEXT_STORAGE_KEY = 'editorContexts';
const REVERIFICATION_STORAGE_KEY = 'editorReverifications';
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

function validatedEditorContext(value, configuration) {
  const expectedFormat = value?.expectedFormat;
  if (!value || typeof value.returnURL !== 'string' || typeof value.sourceURL !== 'string' ||
      typeof value.sourcePath !== 'string' || typeof value.title !== 'string' ||
      typeof value.filename !== 'string' || !['doc', 'docx'].includes(expectedFormat) ||
      value.trustedOrigin !== configuration.trustedOrigin || value.gatewayTemplate !== configuration.gatewayTemplate) return undefined;
  try {
    const returnURL = new URL(value.returnURL);
    const sourceURL = new URL(value.sourceURL);
    if (returnURL.origin !== configuration.trustedOrigin || sourceURL.origin !== configuration.trustedOrigin ||
        sourceURL.username || sourceURL.password || sourceURL.pathname !== value.sourcePath ||
        !new RegExp(`\\.${expectedFormat}$`, 'i').test(sourceURL.pathname)) return undefined;
  } catch {
    return undefined;
  }
  return {
    returnURL: value.returnURL,
    trustedOrigin: configuration.trustedOrigin,
    sourceURL: value.sourceURL,
    sourcePath: value.sourcePath,
    title: value.title,
    filename: value.filename,
    expectedFormat,
    gatewayTemplate: configuration.gatewayTemplate
  };
}

async function storeHandoff(context, pendingVerification = false, ownerTabID) {
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
      ...context,
      ownerTabID,
      createdAt,
      expiresAt: createdAt + HANDOFF_TTL_MS,
      ...(pendingVerification ? { pendingVerification: true, retryTabID: ownerTabID } : {})
    };
    await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
    return { handoffID, handoff: handoffs[handoffID] };
  });
}

async function createEditorHandoff(activation, sender) {
  const configuration = await configuredIntegration();
  if (!configuration || !Number.isInteger(sender?.tab?.id) || sender.url !== activation?.returnURL ||
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
  const sourceIdentity = RoadFlowSourceIdentityContract.validate(
    activation.sourceIdentity,
    sourcePath,
    expectedFormat
  );
  if (!sourceIdentity && activation.sourceVerificationFailed !== true) return { ok: false };
  const stored = await storeHandoff({
    returnURL: sender.url,
    trustedOrigin: configuration.trustedOrigin,
    sourceURL: source.href,
    sourcePath,
    title,
    filename,
    expectedFormat,
    gatewayTemplate: configuration.gatewayTemplate,
    ...(sourceIdentity ? { sourceIdentity } : { sourceVerificationFailed: true })
  }, false, sender.tab.id);
  const editorURL = new URL(chrome.runtime.getURL('editor.html'));
  editorURL.searchParams.set('handoff', stored.handoffID);
  return { ok: true, editorURL: editorURL.href };
}

function consumeEditorHandoff(handoffID, sender) {
  if (!editorSender(sender) || !Number.isInteger(sender?.tab?.id) || !HANDOFF_ID_PATTERN.test(handoffID || '') ||
      new URL(sender.url).search !== `?handoff=${handoffID}`) return Promise.resolve({ ok: false });
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY);
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    const handoff = handoffs[handoffID];
    if (handoff && handoff.ownerTabID !== sender.tab.id) return { ok: false };
    delete handoffs[handoffID];
    await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
    if (!handoff || handoff.pendingVerification || handoff.expiresAt <= Date.now()) return { ok: false };
    const contexts = (await chrome.storage.session.get(EDITOR_CONTEXT_STORAGE_KEY))[EDITOR_CONTEXT_STORAGE_KEY] || {};
    const { ownerTabID, ...editorHandoff } = handoff;
    contexts[sender.tab.id] = { handoff: editorHandoff, editorURL: sender.url };
    await chrome.storage.session.set({ [EDITOR_CONTEXT_STORAGE_KEY]: contexts });
    return { ok: true, handoff: editorHandoff };
  });
}

async function createReverificationHandoff(previousHandoff, sender) {
  if (!editorSender(sender) || !Number.isInteger(sender?.tab?.id)) return { ok: false };
  const configuration = await configuredIntegration();
  const context = await serializedHandoffOperation(async () => {
    const contexts = (await chrome.storage.session.get(EDITOR_CONTEXT_STORAGE_KEY))[EDITOR_CONTEXT_STORAGE_KEY] || {};
    const active = contexts[sender.tab.id];
    if (!active || active.editorURL !== sender.url || active.retryPendingUntil > Date.now()) return undefined;
    const context = validatedEditorContext(active.handoff, configuration || {});
    const requested = validatedEditorContext(previousHandoff, configuration || {});
    if (!context || JSON.stringify(context) !== JSON.stringify(requested)) return undefined;
    active.retryPendingUntil = Date.now() + HANDOFF_TTL_MS;
    await chrome.storage.session.set({ [EDITOR_CONTEXT_STORAGE_KEY]: contexts });
    return context;
  });
  if (!context) return { ok: false };
  const stored = await storeHandoff(context, true, sender.tab.id);
  await serializedHandoffOperation(async () => {
    const session = await chrome.storage.session.get(REVERIFICATION_STORAGE_KEY);
    const reverifications = session[REVERIFICATION_STORAGE_KEY] || {};
    reverifications[sender.tab.id] = {
      handoffID: stored.handoffID,
      returnURL: context.returnURL,
      sourceURL: context.sourceURL,
      expectedFormat: context.expectedFormat,
      expiresAt: stored.handoff.expiresAt
    };
    await chrome.storage.session.set({ [REVERIFICATION_STORAGE_KEY]: reverifications });
  });
  return { ok: true, returnURL: context.returnURL };
}

function cancelReverification(sender) {
  if (!editorSender(sender) || !Number.isInteger(sender?.tab?.id)) return Promise.resolve({ ok: false });
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get([
      HANDOFF_STORAGE_KEY, EDITOR_CONTEXT_STORAGE_KEY, REVERIFICATION_STORAGE_KEY
    ]);
    const contexts = stored[EDITOR_CONTEXT_STORAGE_KEY] || {};
    const active = contexts[sender.tab.id];
    if (!active || active.editorURL !== sender.url) return { ok: false };
    const reverifications = stored[REVERIFICATION_STORAGE_KEY] || {};
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    const pendingID = reverifications[sender.tab.id]?.handoffID;
    if (pendingID) delete handoffs[pendingID];
    delete reverifications[sender.tab.id];
    delete active.retryPendingUntil;
    await chrome.storage.session.set({
      [HANDOFF_STORAGE_KEY]: handoffs,
      [EDITOR_CONTEXT_STORAGE_KEY]: contexts,
      [REVERIFICATION_STORAGE_KEY]: reverifications
    });
    return { ok: true };
  });
}

function claimReverification(sender) {
  if (!Number.isInteger(sender?.tab?.id)) return Promise.resolve({ ok: false });
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get(REVERIFICATION_STORAGE_KEY);
    const reverifications = stored[REVERIFICATION_STORAGE_KEY] || {};
    const request = reverifications[sender.tab.id];
    if (!request) {
      const contexts = (await chrome.storage.session.get(EDITOR_CONTEXT_STORAGE_KEY))[EDITOR_CONTEXT_STORAGE_KEY] || {};
      if (contexts[sender.tab.id]?.handoff.returnURL === sender.url) {
        delete contexts[sender.tab.id];
        await chrome.storage.session.set({ [EDITOR_CONTEXT_STORAGE_KEY]: contexts });
      }
      return { ok: false };
    }
    if (request.returnURL !== sender.url && request.expiresAt > Date.now()) return { ok: false };
    delete reverifications[sender.tab.id];
    await chrome.storage.session.set({ [REVERIFICATION_STORAGE_KEY]: reverifications });
    if (!request || request.returnURL !== sender.url || request.expiresAt <= Date.now()) return { ok: false };
    return {
      ok: true,
      handoffID: request.handoffID,
      sourceURL: request.sourceURL,
      expectedFormat: request.expectedFormat
    };
  });
}

function completeReverificationHandoff(handoffID, sourceIdentity, sourceVerificationFailed, sender) {
  if (!HANDOFF_ID_PATTERN.test(handoffID || '') || !Number.isInteger(sender?.tab?.id)) {
    return Promise.resolve({ ok: false });
  }
  return serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get(HANDOFF_STORAGE_KEY);
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    const handoff = handoffs[handoffID];
    if (!handoff?.pendingVerification || handoff.retryTabID !== sender.tab.id ||
        handoff.returnURL !== sender.url || handoff.expiresAt <= Date.now()) return { ok: false };
    const identity = RoadFlowSourceIdentityContract.validate(sourceIdentity, handoff.sourcePath, handoff.expectedFormat);
    if (!identity && sourceVerificationFailed !== true) {
      delete handoffs[handoffID];
      await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
      return { ok: false };
    }
    delete handoff.pendingVerification;
    delete handoff.retryTabID;
    if (identity) handoff.sourceIdentity = identity;
    else handoff.sourceVerificationFailed = true;
    await chrome.storage.session.set({ [HANDOFF_STORAGE_KEY]: handoffs });
    const editorURL = new URL(chrome.runtime.getURL('editor.html'));
    editorURL.searchParams.set('handoff', handoffID);
    return { ok: true, editorURL: editorURL.href };
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
  if (request?.type === 'create-reverification-handoff') {
    createReverificationHandoff(request.previousHandoff, sender).then(respond).catch(() => respond({ ok: false }));
    return true;
  }
  if (request?.type === 'cancel-reverification') {
    cancelReverification(sender).then(respond).catch(() => respond({ ok: false }));
    return true;
  }
  if (request?.type === 'claim-reverification') {
    claimReverification(sender).then(respond).catch(() => respond({ ok: false }));
    return true;
  }
  if (request?.type === 'complete-reverification-handoff') {
    completeReverificationHandoff(request.handoffID, request.sourceIdentity, request.sourceVerificationFailed, sender)
      .then(respond).catch(() => respond({ ok: false }));
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

// Tab closure drops both unconsumed handoffs and the consumed recovery context.
chrome.tabs?.onRemoved?.addListener(tabID => {
  void serializedHandoffOperation(async () => {
    const stored = await chrome.storage.session.get([
      HANDOFF_STORAGE_KEY, EDITOR_CONTEXT_STORAGE_KEY, REVERIFICATION_STORAGE_KEY
    ]);
    const handoffs = stored[HANDOFF_STORAGE_KEY] || {};
    for (const [id, handoff] of Object.entries(handoffs)) {
      if (handoff.ownerTabID === tabID) delete handoffs[id];
    }
    const contexts = stored[EDITOR_CONTEXT_STORAGE_KEY] || {};
    const reverifications = stored[REVERIFICATION_STORAGE_KEY] || {};
    delete contexts[tabID];
    delete reverifications[tabID];
    await chrome.storage.session.set({
      [HANDOFF_STORAGE_KEY]: handoffs,
      [EDITOR_CONTEXT_STORAGE_KEY]: contexts,
      [REVERIFICATION_STORAGE_KEY]: reverifications
    });
  }).catch(() => {});
});
