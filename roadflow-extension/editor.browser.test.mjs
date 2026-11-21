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

for (const { name, format, editable, mimeType, saveCalls, deliveryRejected } of [
  { name: 'opens and saves DOCX', format: 'docx', editable: '正文可编辑', mimeType: 'application/x-wps', saveCalls: 'overwriteCalls' },
  { name: 'opens and saves XLSX', format: 'xlsx', editable: '表格可编辑', mimeType: 'application/x-et', saveCalls: 'spreadsheetSaveCalls' },
  { name: 'keeps saving disabled when delivery is rejected', format: 'docx', deliveryRejected: true }
]) {
  test(`ftp-master ${name}`, async ({ context, page }) => {
    const origin = 'http://ftp.example.test';
    const permitId = 'c'.repeat(48);
    const base = `/api/office/permits/${permitId}`;
    const permit = {
      versionId: 23, permitId, format, title: `报告.${format}`,
      documentUrl: `${base}/document/Report.${format}`,
      deliveryCheckUrl: `${base}/delivery`, saveUrl: `${base}/save`
    };
    let deliveryChecks = 0;
    const editorKind = format === 'xlsx' ? 'spreadsheet' : 'writer';
    await context.addInitScript(installWPSBoundary, { editorKind });
    await context.addInitScript(origin => {
      globalThis.FtpOfficeOrigin = origin;
      Object.defineProperty(navigator, 'mimeTypes', { value: { namedItem: () => ({}) } });
      Object.defineProperty(globalThis, 'chrome', { value: { runtime: {
        getManifest: () => ({ version: '0.1.0' }),
        getURL: name => `${origin}/assets/${name}`
      } } });
    }, origin);
    const assets = {
      'content.js': '../ftp-master-extension/content.js',
      'ftp-editor.js': '../ftp-master-extension/ftp-editor.js',
      'hosted-editor.html': './hosted-editor.html',
      'hosted-editor.css': './hosted-editor.css',
      'hosted-editor.js': './hosted-editor.js',
      'format-capabilities.js': './format-capabilities.js'
    };
    await context.route(`${origin}/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="/api/files/7/office-edits"
          data-ftp-office-edit="1" data-ftp-office-version="23">在线编辑</a>
          <script src="/assets/content.js"></script>` });
      } else if (path === '/api/files/7/office-edits') {
        expect(route.request().method()).toBe('POST');
        expect(route.request().postDataJSON()).toEqual({ versionId: 23 });
        await route.fulfill({ status: 201, json: permit });
      } else if (path === permit.deliveryCheckUrl) {
        deliveryChecks += 1;
        if (deliveryRejected && deliveryChecks === 2) await route.fulfill({ status: 401 });
        else await route.fulfill({ json: { delivered: deliveryChecks === 2 } });
      } else if (path.startsWith('/assets/') && Object.hasOwn(assets, path.slice(8))) {
        const name = path.slice(8);
        await route.fulfill({
          contentType: name.endsWith('.js') ? 'text/javascript' : 'text/plain',
          body: await readFile(new URL(assets[name], import.meta.url))
        });
      } else await route.fulfill({ status: 404 });
    });
    await page.goto(origin);
    await expect(page.locator('html')).toHaveAttribute('data-ftp-office-plugin', '0.1.0');
    const popupCreated = page.waitForEvent('popup');
    await page.getByRole('link', { name: '在线编辑' }).click();
    const popup = await popupCreated;
    if (deliveryRejected) {
      await expect(popup.locator('#editor-status')).toContainText('无法确认 WPS 收到所选文件');
      await expect(popup.locator('#wps-surface')).toHaveCount(0);
      await expect(popup.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
      expect(await popup.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls)).toEqual([]);
      return;
    }
    await expect(popup.locator('#editor-status')).toHaveText(editable);
    await expect(popup.locator('#wps-surface')).toHaveAttribute('type', mimeType);
    expect(deliveryChecks).toBe(2);
    const openCalls = format === 'xlsx' ? 'workbookOpenCalls' : 'openCalls';
    expect(await popup.evaluate(key => globalThis.__roadFlowObservations[key][0].url, openCalls))
      .toBe(`${origin}${permit.documentUrl}`);
    await popup.getByRole('button', { name: '保存', exact: true }).click();
    await expect(popup.locator('#editor-status')).toHaveText('已保存');
    expect(await popup.evaluate(key => globalThis.__roadFlowObservations[key][0].url, saveCalls))
      .toBe(`${origin}${permit.saveUrl}`);
    const returned = popup.waitForEvent('close');
    await popup.getByRole('button', { name: '返回文件列表' }).click();
    await returned;
    await expect(page.getByRole('link', { name: '在线编辑' })).toBeVisible();
  });
}
