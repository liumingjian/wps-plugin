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
const XL_SHARED = 2;
const XL_ALL_CHANGES = 3;
let currentContext;
let application;
let wpsObject;
let openedOfficeFile;
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
  const capability = RoadFlowFormatCapabilities.forFormat(value?.expectedFormat);
  const returnMode = value?.returnMode || 'navigate';
  if (!value || !capability || value.handoff !== handoff || value.sourcePath !== value.sourceIdentity?.sourcePath ||
      value.expectedFormat !== value.sourceIdentity?.actualFormat ||
      (value.editorKind && value.editorKind !== capability.editorKind) ||
      !['navigate', 'close'].includes(returnMode) ||
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
  return { ...value, editorKind: capability.editorKind, returnMode };
}

function destroyWPS() {
  debug('wps-surface-destroyed', { editorState });
  application = undefined;
  wpsObject = undefined;
  openedOfficeFile = undefined;
  host.className = '';
  host.replaceChildren();
}

function mountWPS() {
  destroyWPS();
  wpsObject = document.createElement('object');
  wpsObject.id = 'wps-surface';
  wpsObject.name = 'wps-surface';
  const capability = RoadFlowFormatCapabilities.forFormat(currentContext?.expectedFormat);
  wpsObject.type = capability?.mimeType || 'application/x-wps';
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

function activeOfficeFile() {
  const candidates = [];
  if (currentContext?.editorKind === 'spreadsheet') {
    try { candidates.push(application?.ActiveWorkbook); } catch (error) {
      debug('wps-active-workbook-probe-failed', { error: debugError(error) });
    }
  }
  try { candidates.push(application?.ActiveDocument); } catch (error) {
    debug('wps-active-document-probe-failed', { error: debugError(error) });
  }
  candidates.push(openedOfficeFile);
  return candidates.find(candidate =>
    candidate && ['function', 'object'].includes(typeof candidate)
  );
}

async function waitForActiveOfficeFile() {
  debug('wps-office-file-wait-start', {
    editorKind: currentContext?.editorKind,
    attempts: 30,
    intervalMilliseconds: 250
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (activeOfficeFile()) {
      debug('wps-office-file-ready', { editorKind: currentContext?.editorKind, attempt: attempt + 1 });
      return;
    }
    await delay(250);
  }
  debug('wps-office-file-timeout', { editorKind: currentContext?.editorKind, attempts: 30 });
  throw new Error(currentContext?.editorKind === 'spreadsheet'
    ? 'WPS ActiveWorkbook 创建超时'
    : 'WPS ActiveDocument 创建超时');
}

function enableWriterRevisionTracking() {
  const activeDocument = activeOfficeFile();
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

function enableSpreadsheetRevisionTracking() {
  const workbook = activeOfficeFile();
  const hasRevisionAPI = workbook && (
    typeof workbook.HighlightChangesOptions === 'function' ||
    typeof workbook.KeepChangeHistory !== 'undefined' ||
    typeof workbook.HighlightChangesOnScreen !== 'undefined' ||
    typeof workbook.ListChangesOnNewSheet !== 'undefined'
  );
  if (!hasRevisionAPI) throw new Error('WPS 表格修订接口不可用');

  if (workbook.MultiUserEditing !== true) {
    const workbookPath = workbook.FullName;
    if (typeof workbook.SaveAs !== 'function' || typeof workbookPath !== 'string' || !workbookPath) {
      throw new Error('WPS 无法将表格切换为共享修订模式');
    }
    const canRestoreDisplayAlerts = application && typeof application.DisplayAlerts !== 'undefined';
    const previousDisplayAlerts = canRestoreDisplayAlerts ? application.DisplayAlerts : undefined;
    try {
      if (canRestoreDisplayAlerts) application.DisplayAlerts = false;
      workbook.SaveAs(workbookPath, undefined, undefined, undefined, undefined, undefined, XL_SHARED);
    } finally {
      if (canRestoreDisplayAlerts) application.DisplayAlerts = previousDisplayAlerts;
    }
  }
  if (workbook.MultiUserEditing !== true) throw new Error('WPS 未能开启表格共享修订模式');

  workbook.KeepChangeHistory = true;
  if (typeof workbook.HighlightChangesOptions === 'function') {
    workbook.HighlightChangesOptions(XL_ALL_CHANGES, 'Everyone');
  }
  workbook.HighlightChangesOnScreen = true;
  workbook.ListChangesOnNewSheet = false;

  const state = {
    keepChangeHistory: workbook.KeepChangeHistory,
    highlightChangesOnScreen: workbook.HighlightChangesOnScreen,
    listChangesOnNewSheet: workbook.ListChangesOnNewSheet,
    multiUserEditing: workbook.MultiUserEditing
  };
  debug('wps-spreadsheet-revision-state', state);
  if (!state.keepChangeHistory) throw new Error('WPS 未能开启表格修订留痕');
  if (state.multiUserEditing === true && !state.highlightChangesOnScreen) {
    throw new Error('WPS 未能显示表格修订');
  }
}

function enableRevisionTracking() {
  if (currentContext?.editorKind === 'spreadsheet') {
    enableSpreadsheetRevisionTracking();
    return;
  }
  enableWriterRevisionTracking();
}

function openOfficeFile() {
  openedOfficeFile = undefined;
  if (currentContext?.editorKind === 'spreadsheet') {
    const openWorkbook = application?.Workbooks?.Open;
    if (typeof openWorkbook === 'function') {
      debug('wps-open-workbook', { documentURL: debugURL(currentContext.documentURL) });
      openedOfficeFile = openWorkbook.call(application.Workbooks, currentContext.documentURL);
      debug('wps-open-workbook-returned', {
        objectAvailable: Boolean(openedOfficeFile && ['function', 'object'].includes(typeof openedOfficeFile))
      });
      return openedOfficeFile;
    }
  }
  if (typeof application?.openDocument !== 'function') {
    throw new Error('WPS 打开接口不可用');
  }
  openedOfficeFile = application.openDocument(currentContext.documentURL, false);
  return openedOfficeFile;
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
  openOfficeFile();
  debug('wps-open-document-called', { documentURL: debugURL(context.documentURL), editorKind: context.editorKind });
  await waitForActiveOfficeFile();
  enableRevisionTracking();
  host.className = 'unlocked';
  editorState = 'editable';
  status.textContent = context.editorKind === 'spreadsheet' ? '表格可编辑' : '正文可编辑';
  saveButton.disabled = false;
  returnButton.disabled = false;
}

function spreadsheetSaveResultAccepted(result) {
  if (result === true) return true;
  if (typeof result !== 'string') return false;
  try {
    const response = JSON.parse(result);
    return response?.result === true || response?.Success === true || response?.success === true;
  } catch {
    return false;
  }
}

function saveSpreadsheetDocument(workbook) {
  if (!workbook || typeof workbook.Save !== 'function' || typeof application?.SaveDocumentToServer !== 'function') {
    throw new Error('WPS 表格保存接口不可用');
  }
  const localSaveResult = workbook.Save();
  if (localSaveResult === false) throw new Error('WPS 表格本地保存失败');
  const result = application.SaveDocumentToServer(currentContext.officeSaveURL);
  debug('wps-spreadsheet-save-response', { result, officeSaveURL: debugURL(currentContext.officeSaveURL) });
  if (!spreadsheetSaveResultAccepted(result)) throw new Error('overwrite rejected');
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
    const officeFile = activeOfficeFile();
    if (currentContext.editorKind === 'spreadsheet') {
      saveSpreadsheetDocument(officeFile);
    } else {
      if (!officeFile || typeof officeFile.saveURL_FormData !== 'function') {
        throw new Error('WPS 保存接口不可用');
      }
      const result = officeFile.saveURL_FormData(currentContext.officeSaveURL, 'formId:formeditor');
      debug('wps-save-response', { result, officeSaveURL: debugURL(currentContext.officeSaveURL) });
      if (result !== true) throw new Error('overwrite rejected');
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

function returnToOriginalPage() {
  debug('return-to-oa', {
    returnMode: currentContext?.returnMode,
    returnURL: debugURL(currentContext?.returnURL),
    editorState
  });
  if (currentContext?.returnMode === 'close') {
    try { window.opener?.focus?.(); } catch (error) { debug('opener-focus-failed', { error: debugError(error) }); }
    window.close();
    return;
  }
  location.replace(currentContext.returnURL);
}

function returnToOA() {
  if (!currentContext || ['opening', 'overwriting'].includes(editorState)) return;
  if (editorState === 'overwrite-failed' && !confirm('保存失败。放弃当前修改并返回 OA？')) return;
  returnToOriginalPage();
}

function requestReverification() {
  if (!currentContext) return;
  debug('reverification-requested', { returnURL: debugURL(currentContext.returnURL) });
  retryButton.disabled = true;
  status.textContent = '正在返回 OA，请重新打开文档';
  returnToOriginalPage();
}

retryButton.addEventListener('click', requestReverification);
saveButton.addEventListener('click', () => void saveDocument());
returnButton.addEventListener('click', returnToOA);
void enterEditor().catch(showFailure);
