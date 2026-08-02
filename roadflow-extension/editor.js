'use strict';

const title = document.querySelector('#document-title');
const sourceLabel = document.querySelector('#source-label');
const status = document.querySelector('#editor-status');
const host = document.querySelector('#editor-host');
const retryButton = document.querySelector('#retry-verification');
const saveButton = document.querySelector('#save-document');
const returnButton = document.querySelector('#return-to-oa');
const HANDOFF_ID_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_TIMEOUT_MS = 10_000;
const RECEIPT_POLL_MS = 250;
let currentHandoff;
let wpsObject;
let application;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function showUnavailableEditor() {
  status.textContent = 'This editor cannot be opened. Return to the OA page and activate the Document Link again.';
}

function validatedHandoff(value, handoffID) {
  const identity = RoadFlowSourceIdentityContract.validate(
    value?.sourceIdentity,
    value?.sourcePath,
    value?.expectedFormat
  );
  if (!value || typeof value.returnURL !== 'string' || typeof value.trustedOrigin !== 'string' ||
      typeof value.sourceURL !== 'string' || typeof value.sourcePath !== 'string' ||
      typeof value.title !== 'string' || typeof value.filename !== 'string' ||
      typeof value.gatewayTemplate !== 'string' || !['doc', 'docx'].includes(value.expectedFormat) ||
      (value.expectedFormat === 'docx' && !identity) ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return undefined;
  try {
    const returnURL = new URL(value.returnURL);
    const sourceURL = new URL(value.sourceURL);
    if (!['http:', 'https:'].includes(returnURL.protocol) || returnURL.origin !== value.trustedOrigin ||
        !['http:', 'https:'].includes(sourceURL.protocol) || sourceURL.username || sourceURL.password ||
        sourceURL.origin !== value.trustedOrigin || sourceURL.pathname !== value.sourcePath || !value.sourcePath.startsWith('/') ||
        !new RegExp(`\\.${value.expectedFormat}$`, 'i').test(value.sourcePath)) return undefined;
    RoadFlowIdentityGate.endpoints(value.gatewayTemplate, value.sourcePath, handoffID);
  } catch {
    return undefined;
  }
  return value;
}

function destroyUnverifiedWPS() {
  application = undefined;
  wpsObject = undefined;
  host.className = '';
  host.replaceChildren();
}

function mountWPS() {
  destroyUnverifiedWPS();
  wpsObject = document.createElement('object');
  wpsObject.id = 'wps-surface';
  wpsObject.name = 'wps-surface';
  wpsObject.type = 'application/x-wps';
  wpsObject.ariaLabel = 'WPS Document editor';
  const enabled = document.createElement('param');
  enabled.name = 'Enabled';
  enabled.value = '1';
  wpsObject.append(enabled);
  host.className = 'locked';
  host.replaceChildren(wpsObject);
}

async function waitForApplication() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const candidate = wpsObject?.Application;
      if (candidate && ['function', 'object'].includes(typeof candidate)) return candidate;
    } catch {}
    await delay(500);
  }
  throw new Error('WPS application unavailable.');
}

async function waitForActiveDocument() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (application?.ActiveDocument) return;
    await delay(250);
  }
  throw new Error('WPS did not expose the active Document.');
}

async function waitForReceipt(receiptURL, handoffID, identity, attemptStartedAt) {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(receiptURL, { cache: 'no-store', credentials: 'omit' });
    if (response.status === 409) throw new Error('Gateway returned conflicting receipts.');
    if (response.status === 204) {
      await delay(RECEIPT_POLL_MS);
      continue;
    }
    if (response.ok) {
      let candidate;
      try { candidate = await response.json(); } catch {}
      const receipt = RoadFlowIdentityGate.validateReceipt(
        candidate, handoffID, identity, Date.now(), attemptStartedAt
      );
      if (!receipt) throw new Error('Gateway Delivery Receipt did not match the source Document.');
      return receipt;
    }
    if (response.status !== 404) throw new Error('Gateway Delivery Receipt lookup failed.');
    await delay(RECEIPT_POLL_MS);
  }
  throw new Error('Gateway Delivery Receipt verification timed out.');
}

function showVerificationFailure() {
  destroyUnverifiedWPS();
  status.textContent = '验证失败，未开放编辑或保存。';
  retryButton.hidden = false;
  retryButton.disabled = false;
  saveButton.disabled = true;
  returnButton.disabled = false;
}

async function verifyHandoff(handoffID, handoff) {
  currentHandoff = handoff;
  title.textContent = handoff.title;
  sourceLabel.textContent = handoff.sourcePath;
  status.textContent = '正在打开正文';
  retryButton.hidden = true;
  retryButton.disabled = true;
  saveButton.disabled = true;
  returnButton.disabled = true;

  if (handoff.expectedFormat !== 'docx') throw new Error('Legacy DOC verification is not available.');
  const attemptStartedAt = Date.now();
  const endpoints = RoadFlowIdentityGate.endpoints(
    handoff.gatewayTemplate, handoff.sourcePath, handoffID
  );
  mountWPS();
  application = await waitForApplication();
  if (application.openDocument(endpoints.documentURL, false) !== true) {
    throw new Error('WPS did not open the Gateway Document.');
  }
  await waitForActiveDocument();
  await waitForReceipt(endpoints.receiptURL, handoffID, handoff.sourceIdentity, attemptStartedAt);
  host.className = 'unlocked';
  status.textContent = '正文可编辑';
  saveButton.disabled = false;
  returnButton.disabled = false;
}

async function consumeHandoff(handoffID) {
  const response = await chrome.runtime.sendMessage({ type: 'consume-editor-handoff', handoffID });
  return response?.ok ? validatedHandoff(response.handoff, handoffID) : undefined;
}

async function reverify() {
  retryButton.disabled = true;
  saveButton.disabled = true;
  returnButton.disabled = true;
  status.textContent = '正在重新验证';
  destroyUnverifiedWPS();

  const created = await chrome.runtime.sendMessage({
    type: 'create-reverification-handoff',
    previousHandoff: currentHandoff
  });
  if (!created?.ok || created.returnURL !== currentHandoff.returnURL) {
    throw new Error('Fresh Editor Handoff was not created.');
  }
  location.replace(created.returnURL);
}

async function enterEditor() {
  const parameters = new URLSearchParams(location.search);
  const keys = [...parameters.keys()];
  const handoffID = keys.length === 1 && keys[0] === 'handoff' ? parameters.get('handoff') : undefined;
  if (!HANDOFF_ID_PATTERN.test(handoffID || '')) {
    showUnavailableEditor();
    return;
  }
  let handoff;
  try { handoff = await consumeHandoff(handoffID); } catch {}
  if (!handoff) {
    showUnavailableEditor();
    return;
  }
  try {
    await verifyHandoff(handoffID, handoff);
  } catch {
    showVerificationFailure();
  }
}

retryButton.addEventListener('click', () => void reverify().catch(showVerificationFailure));
returnButton.addEventListener('click', () => location.replace(currentHandoff.returnURL));

void enterEditor();
