import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const hostedEditorURL = 'http://ywsh.yn.srrc.org.cn/hosted-editor.html';
const handoffID = 'a'.repeat(64);
const sourcePath = '/Attachment/UploadFiles/202608/03//测试文档20260803_NHZP84.docx';
const documentURL = 'http://ywsh.yn.srrc.org.cn/Attachment/UploadFiles/202608/03//%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A320260803_NHZP84.docx';

function installWPSBoundary(scenario) {
  const overwriteResults = [...(scenario.overwriteResults || [true])];
  const observations = { openCalls: [], overwriteCalls: [] };
  globalThis.__roadFlowObservations = observations;
  const revisionView = {};
  const activeDocument = scenario.activeDocument === false ? undefined : {
    ActiveWindow: scenario.revisionAPI === false ? undefined : { View: revisionView },
    saveURL_FormData(url, metadata) {
      observations.overwriteCalls.push({ url, metadata });
      const result = overwriteResults.shift();
      if (result === 'throw') throw new Error('OA rejected overwrite');
      return result ?? true;
    }
  };
  const application = {
    ActiveDocument: activeDocument,
    openDocument(url, readOnly) {
      observations.openCalls.push({ url, readOnly });
      return scenario.openResult ?? true;
    }
  };
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function (name, options) {
    const element = createElement.call(this, name, options);
    if (String(name).toLowerCase() === 'object') {
      Object.defineProperty(element, 'Application', { configurable: true, value: application });
    }
    return element;
  };
}

async function openHostedEditor(page, scenario = {}) {
  const sourceIdentity = {
    sourcePath,
    actualFormat: 'docx',
    byteCount: 4096,
    sha256: 'b'.repeat(64)
  };
  await page.addInitScript(installWPSBoundary, scenario);
  await page.addInitScript(({ documentURL, handoffID, sourceIdentity }) => {
    const officeSaveURL = new URL('/RoadFlow/uploadfiles/OfficeSave', location.origin);
    officeSaveURL.searchParams.set('fileurl', sourceIdentity.sourcePath);
    globalThis.RoadFlowEditorContext = {
      handoff: handoffID,
      sourcePath: sourceIdentity.sourcePath,
      expectedFormat: sourceIdentity.actualFormat,
      sourceIdentity,
      title: '测试文档20260803_NHZP84.docx',
      documentURL,
      officeSaveURL: officeSaveURL.href,
      returnURL: `${location.origin}/workflow/current`
    };
  }, { documentURL, handoffID, sourceIdentity });
  await page.route('http://ywsh.yn.srrc.org.cn/**', async route => {
    const assetName = new URL(route.request().url()).pathname.slice(1);
    const sourceAsset = {
      'hosted-editor.html': 'hosted-editor.html',
      'wps/editor.css': 'hosted-editor.css',
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
});

test('editing stays locked when the WPS revision interface is unavailable', async ({ page }) => {
  await openHostedEditor(page, { revisionAPI: false });

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
