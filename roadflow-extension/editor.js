'use strict';

const title = document.querySelector('#document-title');
const sourceLabel = document.querySelector('#source-label');
const status = document.querySelector('#editor-status');
const host = document.querySelector('#editor-host');
const returnButton = document.querySelector('#return-to-oa');
const HANDOFF_ID_PATTERN = /^[a-f0-9]{64}$/;

function showUnavailableEditor() {
  status.textContent = 'This editor cannot be opened. Return to the OA page and activate the Document Link again.';
}

function validatedHandoff(value) {
  const identity = RoadFlowSourceIdentityContract.validate(
    value?.sourceIdentity,
    value?.sourcePath,
    value?.expectedFormat
  );
  if (!value || typeof value.returnURL !== 'string' || typeof value.trustedOrigin !== 'string' ||
      typeof value.sourceURL !== 'string' || typeof value.sourcePath !== 'string' ||
      typeof value.title !== 'string' || typeof value.filename !== 'string' ||
      !['doc', 'docx'].includes(value.expectedFormat) || !/^[a-f0-9]{32}$/.test(value.cacheIdentity || '') ||
      (value.expectedFormat === 'docx' && !identity) ||
      !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) return undefined;
  try {
    const returnURL = new URL(value.returnURL);
    const sourceURL = new URL(value.sourceURL);
    if (!['http:', 'https:'].includes(returnURL.protocol) || returnURL.origin !== value.trustedOrigin ||
        !['http:', 'https:'].includes(sourceURL.protocol) || sourceURL.username || sourceURL.password ||
        sourceURL.origin !== value.trustedOrigin || sourceURL.pathname !== value.sourcePath || !value.sourcePath.startsWith('/') ||
        !new RegExp(`\\.${value.expectedFormat}$`, 'i').test(value.sourcePath)) return undefined;
  } catch {
    return undefined;
  }
  return value;
}

async function enterEditor() {
  const parameters = new URLSearchParams(location.search);
  const keys = [...parameters.keys()];
  const handoffID = keys.length === 1 && keys[0] === 'handoff' ? parameters.get('handoff') : undefined;
  if (!HANDOFF_ID_PATTERN.test(handoffID || '')) {
    showUnavailableEditor();
    return;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'consume-editor-handoff', handoffID });
  } catch {
    showUnavailableEditor();
    return;
  }
  const handoff = response?.ok ? validatedHandoff(response.handoff) : undefined;
  if (!handoff) {
    showUnavailableEditor();
    return;
  }

  title.textContent = handoff.title;
  sourceLabel.textContent = handoff.sourcePath;
  const wpsSurface = document.createElement('object');
  wpsSurface.id = 'wps-surface';
  wpsSurface.type = 'application/x-wps';
  wpsSurface.ariaLabel = 'WPS Document editor';
  host.append(wpsSurface);
  status.textContent = '正在打开正文';
  returnButton.disabled = false;
  returnButton.addEventListener('click', () => location.replace(handoff.returnURL));
}

void enterEditor();
