'use strict';

const HANDOFF_PATTERN = /^[a-f0-9]{64}$/;
const DEBUG_PREFIX = '[RoadFlow WPS debug]';
const title = document.querySelector('#document-title');
const sourceLabel = document.querySelector('#source-label');
const status = document.querySelector('#editor-status');
const host = document.querySelector('#editor-host');
const retryButton = document.querySelector('#retry-verification');
const saveButton = document.querySelector('#save-document');
const returnButton = document.querySelector('#return-to-oa');
let currentContext;
let application;
let wpsObject;
let editorState = 'opening';

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

debug('hosted-editor-loaded', {
  pageURL: debugURL(location.href),
  pageOrigin: location.origin,
  readyState: document.readyState
});

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function handoffFromLocation() {
  const parameters = new URLSearchParams(location.search);
  const keys = [...parameters.keys()];
  const handoff = keys.length === 1 && keys[0] === 'handoff' ? parameters.get('handoff') : '';
  return HANDOFF_PATTERN.test(handoff) ? handoff : undefined;
}

function validHTTPURL(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validatedContext(value, handoff) {
  if (!value || value.handoff !== handoff || value.sourcePath !== value.sourceIdentity?.sourcePath ||
      value.expectedFormat !== value.sourceIdentity?.actualFormat || !['doc', 'docx'].includes(value.expectedFormat) ||
      !Number.isInteger(value.sourceIdentity?.byteCount) || value.sourceIdentity.byteCount <= 0 ||
      !/^[a-f0-9]{64}$/.test(value.sourceIdentity?.sha256 || '') || typeof value.title !== 'string' ||
      typeof value.returnURL !== 'string') return undefined;
  const documentURL = validHTTPURL(value.documentURL);
  const officeSaveURL = validHTTPURL(value.officeSaveURL);
  const returnURL = validHTTPURL(value.returnURL);
  let documentPath;
  try { documentPath = decodeURI(documentURL?.pathname); } catch {}
  if (!documentURL || !officeSaveURL || !returnURL || documentURL.origin !== location.origin ||
      officeSaveURL.origin !== location.origin || returnURL.origin !== location.origin ||
      documentPath !== value.sourcePath || officeSaveURL.searchParams.get('fileurl') !== value.sourcePath) {
    return undefined;
  }
  return value;
}

function destroyWPS() {
  debug('wps-surface-destroyed', { editorState });
  application = undefined;
  wpsObject = undefined;
  host.className = '';
  host.replaceChildren();
}

function mountWPS() {
  destroyWPS();
  wpsObject = document.createElement('object');
  wpsObject.id = 'wps-surface';
  wpsObject.name = 'wps-surface';
  wpsObject.type = 'application/x-wps';
  wpsObject.width = '100%';
  wpsObject.height = '100%';
  wpsObject.setAttribute('hiden_taskpane', 'true');
  wpsObject.ariaLabel = 'WPS Document editor';
  const enabled = document.createElement('param');
  enabled.name = 'Enabled';
  enabled.value = '1';
  wpsObject.append(enabled);
  host.className = 'locked';
  host.replaceChildren(wpsObject);
  debug('wps-surface-mounted', { type: wpsObject.type, enabled: enabled.value });
}

async function waitForApplication() {
  debug('wps-application-wait-start', { attempts: 30, intervalMilliseconds: 500 });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const candidate = wpsObject?.Application;
      if (candidate && ['function', 'object'].includes(typeof candidate)) {
        debug('wps-application-ready', { attempt: attempt + 1, type: typeof candidate });
        return candidate;
      }
    } catch (error) {
      if (attempt === 0) debug('wps-application-probe-failed', { error: debugError(error) });
    }
    await delay(500);
  }
  debug('wps-application-timeout', { attempts: 30 });
  throw new Error('WPS Application 不可用');
}

async function waitForActiveDocument() {
  debug('wps-document-wait-start', { attempts: 30, intervalMilliseconds: 250 });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (application?.ActiveDocument) {
      debug('wps-document-ready', { attempt: attempt + 1 });
      return;
    }
    await delay(250);
  }
  debug('wps-document-timeout', { attempts: 30 });
  throw new Error('WPS ActiveDocument 创建超时');
}

function enableRevisionTracking() {
  const activeDocument = application?.ActiveDocument;
  const view = activeDocument?.ActiveWindow?.View || application?.ActiveWindow?.View;
  if (!activeDocument || !view) throw new Error('WPS 修订接口不可用');

  activeDocument.TrackRevisions = true;
  view.RevisionsView = 0;
  view.ShowRevisionsAndComments = true;
  view.ShowInsertionsAndDeletions = true;
  debug('wps-revision-state', {
    trackRevisions: activeDocument.TrackRevisions,
    revisionsView: Number(view.RevisionsView),
    showRevisionsAndComments: view.ShowRevisionsAndComments,
    showInsertionsAndDeletions: view.ShowInsertionsAndDeletions
  });
  if (!activeDocument.TrackRevisions || !view.ShowRevisionsAndComments ||
      !view.ShowInsertionsAndDeletions || Number(view.RevisionsView) !== 0) {
    throw new Error('WPS 未能开启修订留痕');
  }
}

function showFailure(error) {
  debug('editor-failed', { error: debugError(error), editorState });
  editorState = 'verification-failed';
  destroyWPS();
  status.textContent = `验证失败：${error?.message || '未知错误'}`;
  retryButton.hidden = false;
  retryButton.disabled = false;
  saveButton.disabled = true;
  returnButton.disabled = false;
}

async function enterEditor() {
  debug('editor-context-read-start', { location: debugURL(location.href) });
  const handoff = globalThis.RoadFlowEditorContext?.handoff || handoffFromLocation();
  if (!handoff) throw new Error('编辑交接参数无效');
  let candidate = globalThis.RoadFlowEditorContext;
  if (!candidate) {
    const response = await fetch(`/wps/editor-context?handoff=${handoff}`, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('编辑交接不存在或已过期');
    candidate = await response.json();
  }
  const context = validatedContext(candidate, handoff);
  if (!context) throw new Error('编辑交接内容无效');
  currentContext = context;
  debug('editor-context-validated', {
    handoff: context.handoff,
    sourcePath: context.sourcePath,
    expectedFormat: context.expectedFormat,
    documentURL: debugURL(context.documentURL),
    officeSaveURL: debugURL(context.officeSaveURL),
    returnURL: debugURL(context.returnURL),
    sourceByteCount: context.sourceIdentity.byteCount,
    sourceSHA256: context.sourceIdentity.sha256
  });
  title.textContent = context.title;
  sourceLabel.textContent = context.sourcePath;
  mountWPS();
  application = await waitForApplication();
  debug('wps-open-document-start', { documentURL: debugURL(context.documentURL), readOnly: false });
  application.openDocument(context.documentURL, false);
  debug('wps-open-document-called', { documentURL: debugURL(context.documentURL) });
  await waitForActiveDocument();
  enableRevisionTracking();
  host.className = 'unlocked';
  editorState = 'editable';
  status.textContent = '正文可编辑';
  saveButton.disabled = false;
  returnButton.disabled = false;
}

async function saveDocument() {
  if (!['editable', 'overwritten', 'overwrite-failed'].includes(editorState)) return;
  debug('wps-save-start', {
    officeSaveURL: debugURL(currentContext?.officeSaveURL),
    sourcePath: currentContext?.sourcePath,
    editorState
  });
  editorState = 'overwriting';
  status.textContent = '正在保存';
  saveButton.disabled = true;
  returnButton.disabled = true;
  try {
    const result = application?.ActiveDocument?.saveURL_FormData(currentContext.officeSaveURL, 'formId:formeditor');
    debug('wps-save-response', { result, officeSaveURL: debugURL(currentContext.officeSaveURL) });
    if (result !== true) {
      throw new Error('overwrite rejected');
    }
    editorState = 'overwritten';
    status.textContent = '已保存';
    saveButton.textContent = '保存';
  } catch (error) {
    debug('wps-save-failed', { error: debugError(error), officeSaveURL: debugURL(currentContext.officeSaveURL) });
    editorState = 'overwrite-failed';
    status.textContent = '保存失败';
    saveButton.textContent = '重试保存';
  }
  saveButton.disabled = false;
  returnButton.disabled = false;
}

function returnToOA() {
  if (!currentContext || ['opening', 'overwriting'].includes(editorState)) return;
  if (editorState === 'overwrite-failed' && !confirm('保存失败。放弃当前修改并返回 OA？')) return;
  debug('return-to-oa', { returnURL: debugURL(currentContext.returnURL), editorState });
  location.replace(currentContext.returnURL);
}

function requestReverification() {
  if (!currentContext) return;
  debug('reverification-requested', { returnURL: debugURL(currentContext.returnURL) });
  retryButton.disabled = true;
  status.textContent = '正在返回 OA，请重新打开文档';
  location.replace(currentContext.returnURL);
}

retryButton.addEventListener('click', requestReverification);
saveButton.addEventListener('click', () => void saveDocument());
returnButton.addEventListener('click', returnToOA);
void enterEditor().catch(showFailure);
