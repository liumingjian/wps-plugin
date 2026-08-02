import { expect, test } from '@playwright/test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const editorURL = pathToFileURL(fileURLToPath(new URL('./editor.html', import.meta.url))).href;
const handoffID = 'a'.repeat(64);

async function openEditor(page, scenario = {}) {
  await page.addInitScript(({ handoffID, scenario }) => {
    const sourcePath = scenario.sourcePath || '/UploadFiles/2026/Quarterly%20Report.DOCX';
    const expectedFormat = sourcePath.toLowerCase().endsWith('.doc') ? 'doc' : 'docx';
    const sourceIdentity = {
      sourcePath,
      actualFormat: expectedFormat,
      byteCount: 4096,
      sha256: 'b'.repeat(64)
    };
    const overwriteResults = [...(scenario.overwriteResults || [true])];
    const observations = { openCalls: [], overwriteCalls: [] };
    globalThis.__roadFlowObservations = observations;

    const application = {
      ActiveDocument: scenario.activeDocument === false ? undefined : {
        saveURL_FormData(url, metadata) {
          observations.overwriteCalls.push({ url, metadata });
          const result = overwriteResults.shift();
          if (result === 'throw') throw new Error('OA rejected overwrite');
          return result ?? true;
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
        Object.defineProperty(element, 'Application', { configurable: true, value: application });
      }
      return element;
    };

    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          async sendMessage(message) {
            if (message.type !== 'consume-editor-handoff') return { ok: false };
            return {
              ok: true,
              handoff: {
                returnURL: 'https://oa.example.test/workflow/current?step=review',
                trustedOrigin: 'https://oa.example.test',
                sourceURL: `https://oa.example.test${sourcePath}`,
                sourcePath,
                title: scenario.title || 'Quarterly customer acceptance Document with a long title',
                filename: sourcePath.split('/').at(-1),
                expectedFormat,
                gatewayTemplate: 'https://gateway.example.test/wps/document?fileurl={sourcePath}',
                sourceIdentity,
                createdAt: Date.now() - 100,
                expiresAt: Date.now() + 120_000
              }
            };
          }
        }
      }
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async () => {
        const receipt = {
          handoff: handoffID,
          sourcePath: scenario.receiptMismatch ? '/UploadFiles/2026/Wrong.docx' : sourcePath,
          actualFormat: expectedFormat,
          byteCount: sourceIdentity.byteCount,
          sha256: sourceIdentity.sha256,
          deliveredAt: new Date().toISOString()
        };
        return { ok: true, status: 200, async json() { return receipt; } };
      }
    });
  }, { handoffID, scenario });

  await page.goto(`${editorURL}?handoff=${handoffID}`);
}

test('a failed Document Identity Gate removes WPS and cannot overwrite', async ({ page }) => {
  await openEditor(page, { receiptMismatch: true });

  await expect(page.locator('#editor-status')).toHaveText('验证失败，未开放编辑或保存。');
  await expect(page.locator('#retry-verification')).toBeVisible();
  await expect(page.locator('#save-document')).toBeDisabled();
  await expect(page.locator('#return-to-oa')).toBeEnabled();
  await expect(page.locator('#editor-host object')).toHaveCount(0);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls)).toEqual([]);
});

test('a Recoverable Overwrite Failure keeps WPS and retries only on another click', async ({ page }) => {
  await openEditor(page, { overwriteResults: [false, true] });

  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  const surface = page.locator('#editor-host object');
  await expect(surface).toHaveCount(1);
  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('保存失败');
  await expect(page.locator('#save-document')).toHaveText('重试保存');
  await expect(surface).toHaveCount(1);
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls.length)).toBe(1);

  await page.locator('#save-document').click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  expect(await page.evaluate(() => globalThis.__roadFlowObservations.overwriteCalls.length)).toBe(2);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'narrow', width: 360, height: 640 }
]) {
  test(`editor controls and WPS surface do not overlap at ${viewport.name} width`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openEditor(page);
    await expect(page.locator('#editor-status')).toHaveText('正文可编辑');

    const layout = await page.evaluate(() => {
      const box = selector => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height };
      };
      return {
        header: box('header'),
        context: box('.document-context'),
        status: box('#editor-status'),
        actions: box('.editor-actions'),
        host: box('#editor-host'),
        save: box('#save-document'),
        returnToOA: box('#return-to-oa'),
        viewport: { width: innerWidth, height: innerHeight },
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
