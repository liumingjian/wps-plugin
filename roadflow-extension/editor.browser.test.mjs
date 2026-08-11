import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const hostedEditorURL = 'http://ywsh.yn.srrc.org.cn/hosted-editor.html';
const handoffID = 'a'.repeat(64);
const sourcePath = '/Attachment/UploadFiles/202608/03//测试文档20260803_NHZP84.docx';
const documentURL = 'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03//%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A320260803_NHZP84.docx';

function installWPSBoundary(scenario) {
  const overwriteResults = [...(scenario.overwriteResults || [true])];
  const nativeSaveResults = [...(scenario.nativeSaveResults || overwriteResults)];
  const spreadsheetSaveResults = [...(scenario.spreadsheetSaveResults || [true])];
  const observations = {
    openCalls: [],
    workbookOpenCalls: [],
    overwriteCalls: [],
    spreadsheetSaveCalls: [],
    workbookSaveCalls: [],
    highlightChangesCalls: [],
    saveAsCalls: []
  };
  globalThis.__roadFlowObservations = observations;
  const editorKind = scenario.editorKind || 'writer';
  const applicationReadyAt = performance.now() + Math.max(0, Number(scenario.applicationReadyAfter) || 0);
  const revisionView = {};
  const saveURLFormData = function (url, metadata) {
    observations.overwriteCalls.push({ url, metadata });
    const result = nativeSaveResults.length ? nativeSaveResults.shift() : true;
    if (result === 'throw') throw new Error('OA rejected overwrite');
    return result;
  };
  const workbookRevisionSurface = editorKind === 'spreadsheet' && scenario.spreadsheetRevisionAPI !== false ? {
    FullName: scenario.workbookFullName || '/tmp/roadflow-test/workbook.xls',
    KeepChangeHistory: false,
    HighlightChangesOnScreen: false,
    ListChangesOnNewSheet: false,
    MultiUserEditing: scenario.multiUserEditing === true,
    Save() {
      observations.workbookSaveCalls.push(true);
      if (scenario.workbookSaveResult === 'throw') throw new Error('WPS local save failed');
      return scenario.workbookSaveResult ?? true;
    },
    SaveAs(filename, fileFormat, password, writeResPassword, readOnlyRecommended, createBackup, accessMode) {
      observations.saveAsCalls.push({ filename, fileFormat, accessMode });
      if (accessMode === 2) this.MultiUserEditing = true;
      return true;
    },
    HighlightChangesOptions(when, who, where) {
      observations.highlightChangesCalls.push([when, who, where]);
      return true;
    }
  } : {};
  const openedWorkbook = { saveURL_FormData: saveURLFormData, ...workbookRevisionSurface };
  const activeDocument = scenario.activeDocument === false ||
    (editorKind === 'spreadsheet' && scenario.spreadsheetActiveDocument !== true) ? undefined : {
    ActiveWindow: scenario.revisionAPI === false ? undefined : { View: revisionView },
    saveURL_FormData: saveURLFormData,
    ...workbookRevisionSurface
  };
  const activeWorkbook = editorKind !== 'spreadsheet' || scenario.activeWorkbook === false ? undefined : {
    saveURL_FormData: saveURLFormData,
    ...workbookRevisionSurface
  };
  const application = {
    Name: editorKind === 'spreadsheet' ? 'WPS表格' : 'WPS文字',
    ActiveDocument: activeDocument,
    ActiveWorkbook: activeWorkbook,
    DisplayAlerts: true,
    SaveDocumentToServer(url) {
      observations.spreadsheetSaveCalls.push({ url });
      const result = spreadsheetSaveResults.length ? spreadsheetSaveResults.shift() : true;
      if (result === 'throw') throw new Error('OA rejected spreadsheet overwrite');
      return result;
    },
    Workbooks: {
      Open(url) {
        observations.workbookOpenCalls.push({ url });
        return scenario.openResult === 'workbook' ? openedWorkbook : scenario.openResult ?? true;
      }
    },
    openDocument(url, readOnly) {
      observations.openCalls.push({ url, readOnly });
      return scenario.openResult ?? true;
    }
  };
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() === 'object') {
      Object.defineProperty(element, 'Application', {
        configurable: true,
        get() { return performance.now() >= applicationReadyAt ? application : undefined; }
      });
    }
    return element;
  };
}

async function openHostedEditor(page, scenario = {}) {
  const format = scenario.format || 'docx';
  const editorKind = scenario.editorKind || (['xls', 'xlsx'].includes(format) ? 'spreadsheet' : 'writer');
  const formatSourcePath = scenario.sourcePath || sourcePath;
  const formatDocumentURL = scenario.documentURL || documentURL;
  const sourceIdentity = {
    sourcePath: formatSourcePath,
    actualFormat: format,
    byteCount: 4096,
    sha256: 'b'.repeat(64)
  };
  await page.addInitScript(installWPSBoundary, { ...scenario, editorKind });
  await page.addInitScript(({ documentURL, handoffID, sourceIdentity, editorKind, returnMode }) => {
    const officeSaveURL = new URL('/RoadFlow/uploadfiles/OfficeSave', location.origin);
    officeSaveURL.searchParams.set('fileurl', sourceIdentity.sourcePath);
    globalThis.RoadFlowEditorContext = {
      handoff: handoffID,
      sourcePath: sourceIdentity.sourcePath,
      editorKind,
      expectedFormat: sourceIdentity.actualFormat,
      sourceIdentity,
      title: `测试文档20260803_NHZP84.${sourceIdentity.actualFormat}`,
      documentURL,
      officeSaveURL: officeSaveURL.href,
      returnURL: `${location.origin}/workflow/current`,
      returnMode
    };
    if (returnMode === 'close') {
      globalThis.__roadFlowWindowCloseRequested = false;
      window.close = () => { globalThis.__roadFlowWindowCloseRequested = true; };
    }
  }, { documentURL: formatDocumentURL, handoffID, sourceIdentity, editorKind, returnMode: scenario.returnMode || 'navigate' });
  await page.route('http://ywsh.yn.srrc.org.cn/**', async route => {
    const assetName = new URL(route.request().url()).pathname.slice(1);
    const sourceAsset = {
      'hosted-editor.html': 'hosted-editor.html',
      'wps/editor.css': 'hosted-editor.css',
      'wps/format-capabilities.js': 'format-capabilities.js',
      'wps/editor.js': 'hosted-editor.js'
    }[assetName];
    if (sourceAsset) {
      const body = await readFile(new URL(`./${sourceAsset}`, import.meta.url));
      const contentType = sourceAsset.endsWith('.html') ? 'text/html' :
        sourceAsset.endsWith('.css') ? 'text/css' : 'text/javascript';
      await route.fulfill({ contentType, body });
      return;
    }
    await route.fulfill({ contentType: 'text/html', body: '<p>OA workflow</p>' });
  });
  await page.goto(hostedEditorURL);
}

test('the hosted editor opens the original OA URL directly and enables revision tracking', async ({ page }) => {
  await openHostedEditor(page);

  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.openCalls)).toEqual([
    { url: documentURL, readOnly: false }
  ]);
  expect(await page.evaluate(() => {
    const activeDocument = document.querySelector('#wps-surface').Application.ActiveDocument;
    return {
      trackRevisions: activeDocument.TrackRevisions,
      revisionsView: activeDocument.ActiveWindow.View.RevisionsView,
      showRevisionsAndComments: activeDocument.ActiveWindow.View.ShowRevisionsAndComments,
      showInsertionsAndDeletions: activeDocument.ActiveWindow.View.ShowInsertionsAndDeletions
    };
  })).toEqual({
    trackRevisions: true,
    revisionsView: 0,
    showRevisionsAndComments: true,
    showInsertionsAndDeletions: true
  });
});

test('the WPS surface stays hidden while the plugin is initializing', async ({ page }) => {
  await openHostedEditor(page, { applicationReadyAfter: 1000 });

  await expect(page.locator('#editor-status')).toHaveText('正在打开正文');
  await expect(page.locator('#wps-surface')).toHaveCSS('visibility', 'hidden');
  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  await expect(page.locator('#wps-surface')).toHaveCSS('visibility', 'visible');
});

test('return closes a newly opened editor tab and preserves the OA page', async ({ page }) => {
  await openHostedEditor(page, { returnMode: 'close' });

  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  await page.locator('#return-to-oa').click();
  expect(await page.evaluate(() => globalThis.__roadFlowWindowCloseRequested)).toBe(true);
});

test('OfficeSave receives the decoded customer path and retries a recoverable failure', async ({ page }) => {
  await openHostedEditor(page, { overwriteResults: [false, true] });

  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('保存失败');
  await expect(page.locator('#save-document')).toHaveText('重试保存');
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  const calls = await page.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls);
  expect(calls).toHaveLength(2);
  expect(new URL(calls[0].url).origin).toBe('http://ywsh.yn.srrc.org.cn');
  expect(new URL(calls[0].url).pathname).toBe('/RoadFlow/uploadfiles/OfficeSave');
  expect(new URL(calls[0].url).searchParams.get('fileurl')).toBe(sourcePath);
  expect(calls[0].metadata).toBe('formId:formeditor');
  await expect(page.locator('#return-to-oa')).toHaveText('返回');
});

test('spreadsheet files use the WPS workbook surface without Word revision APIs', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xlsx';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xlsx',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.openCalls)).toEqual([]);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookOpenCalls)).toEqual([
    { url: spreadsheetURL }
  ]);
  expect(await page.evaluate(() => {
    const surface = document.querySelector('#wps-surface').Application;
    return {
      hasActiveWorkbook: Boolean(surface.ActiveWorkbook),
      hasActiveDocument: Boolean(surface.ActiveDocument),
      hasTrackRevisions: 'TrackRevisions' in (surface.ActiveWorkbook || {})
    };
  })).toEqual({ hasActiveWorkbook: true, hasActiveDocument: false, hasTrackRevisions: false });

  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.spreadsheetSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookSaveCalls)).toHaveLength(1);
});

test('spreadsheet save uses ET native upload after saving the workbook locally', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    spreadsheetSaveResults: ['{"result":true}']
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.spreadsheetSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls)).toHaveLength(0);
});

test('spreadsheet save still reports an explicit WPS false return as failure', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    spreadsheetSaveResults: ['{"result":false}']
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('保存失败');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.spreadsheetSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookSaveCalls)).toHaveLength(1);
});

test('spreadsheet editing enables ET revision tracking and displays all changes', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xlsx';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xlsx',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    multiUserEditing: true
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  expect(await page.evaluate(() => {
    const workbook = document.querySelector('#wps-surface').Application.ActiveWorkbook;
    return {
      keepChangeHistory: workbook.KeepChangeHistory,
      highlightChangesOnScreen: workbook.HighlightChangesOnScreen,
      listChangesOnNewSheet: workbook.ListChangesOnNewSheet
    };
  })).toEqual({
    keepChangeHistory: true,
    highlightChangesOnScreen: true,
    listChangesOnNewSheet: false
  });
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.highlightChangesCalls)).toEqual([
    [3, 'Everyone', undefined]
  ]);
});

test('spreadsheet files mount the WPS ET plugin instead of the Writer plugin', async ({ page }) => {
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls',
    documentURL: 'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03/Quarterly-Report.xls'
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  expect(await page.locator('#wps-surface')).toHaveAttribute('type', 'application/x-et');
  expect(await page.evaluate(() => {
    const application = document.querySelector('#wps-surface').Application;
    return { name: application.Name, hasWorkbooks: Boolean(application.Workbooks) };
  })).toEqual({ name: 'WPS表格', hasWorkbooks: true });
});

test('spreadsheet editing converts an exclusive workbook to shared revision mode before highlighting', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  const workbookFullName = '/tmp/roadflow-test/Quarterly-Report.xls';
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    workbookFullName
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑');
  expect(await page.evaluate(() => {
    const workbook = document.querySelector('#wps-surface').Application.ActiveWorkbook;
    return {
      multiUserEditing: workbook.MultiUserEditing,
      keepChangeHistory: workbook.KeepChangeHistory,
      highlightChangesOnScreen: workbook.HighlightChangesOnScreen,
      listChangesOnNewSheet: workbook.ListChangesOnNewSheet
    };
  })).toEqual({
    multiUserEditing: true,
    keepChangeHistory: true,
    highlightChangesOnScreen: true,
    listChangesOnNewSheet: false
  });
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.saveAsCalls)).toEqual([
    { filename: workbookFullName, fileFormat: undefined, accessMode: 2 }
  ]);
});

test('spreadsheet editing uses the workbook returned by WPS when ActiveWorkbook is not exposed', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xlsx';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xlsx',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    activeWorkbook: false,
    openResult: 'workbook'
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑', { timeout: 10000 });
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookOpenCalls)).toEqual([
    { url: spreadsheetURL }
  ]);
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.spreadsheetSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookSaveCalls)).toHaveLength(1);
});

test('spreadsheet editing falls back to WPS ActiveDocument when the workbook API is unavailable', async ({ page }) => {
  const spreadsheetPath = '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls';
  const spreadsheetURL = `http://ywsh.yn.srrc.org.cn${spreadsheetPath}`;
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: spreadsheetPath,
    documentURL: spreadsheetURL,
    activeWorkbook: false,
    spreadsheetActiveDocument: true,
    openResult: true
  });

  await expect(page.locator('#editor-status')).toHaveText('表格可编辑', { timeout: 10000 });
  expect(await page.evaluate(() => {
    const surface = document.querySelector('#wps-surface').Application;
    return {
      hasActiveWorkbook: Boolean(surface.ActiveWorkbook),
      hasActiveDocument: Boolean(surface.ActiveDocument)
    };
  })).toEqual({ hasActiveWorkbook: false, hasActiveDocument: true });
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.spreadsheetSaveCalls)).toHaveLength(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.workbookSaveCalls)).toHaveLength(1);
});

test('editing stays locked when the WPS revision interface is unavailable', async ({ page }) => {
  await openHostedEditor(page, { revisionAPI: false });

  await expect(page.locator('#editor-status')).toContainText('验证失败');
  await expect(page.locator('#editor-host object')).toHaveCount(0);
  await expect(page.locator('#save-document')).toBeDisabled();
});

test('spreadsheet editing stays locked when the ET revision interface is unavailable', async ({ page }) => {
  await openHostedEditor(page, {
    format: 'xls',
    sourcePath: '/Attachment/UploadFiles/202608/03/Quarterly-Report.xls',
    documentURL: 'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03/Quarterly-Report.xls',
    spreadsheetRevisionAPI: false
  });

  await expect(page.locator('#editor-status')).toContainText('验证失败');
  await expect(page.locator('#editor-host object')).toHaveCount(0);
  await expect(page.locator('#save-document')).toBeDisabled();
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'narrow', width: 360, height: 640 }
]) {
  test(`hosted editor controls and WPS surface do not overlap at ${viewport.name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openHostedEditor(page);
    await expect(page.locator('#editor-status')).toHaveText('正文可编辑');

    const layout = await page.evaluate(() => {
      const box = selector => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
      };
      return {
        header: box('header'), context: box('.document-context'), status: box('#editor-status'),
        actions: box('.editor-actions'), host: box('#editor-host'), save: box('#save-document'),
        returnToOA: box('#return-to-oa'), viewport: { width: innerWidth, height: innerHeight },
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    expect(layout.horizontalOverflow).toBe(false);
    expect(layout.actions.right).toBeLessThanOrEqual(layout.viewport.width);
    expect(layout.save.width).toBeGreaterThan(0);
    expect(layout.returnToOA.width).toBeGreaterThan(0);
    expect(layout.host.top).toBeGreaterThanOrEqual(layout.header.bottom);
    expect(layout.host.bottom).toBeLessThanOrEqual(layout.viewport.height);
    expect(layout.host.height).toBeGreaterThan(200);
    if (viewport.name === 'desktop') {
      expect(layout.context.right).toBeLessThanOrEqual(layout.status.left);
      expect(layout.status.right).toBeLessThanOrEqual(layout.actions.left);
    } else {
      expect(layout.context.right).toBeLessThanOrEqual(layout.actions.left);
      expect(layout.status.top).toBeGreaterThanOrEqual(layout.context.bottom);
    }
  });
}
