import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
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

async function openPublicWorkflow(page) {
  const returnURL = 'https://oa.example.test/workflow/current?step=review#document';
  const sourcePath = '/UploadFiles/2026/Quarterly%20Report.DOCX';
  const sourceIdentity = {
    sourcePath,
    actualFormat: 'docx',
    byteCount: 4096,
    sha256: 'c'.repeat(64)
  };
  const handoffs = new Map();
  let handoffSequence = 0;
  await page.exposeFunction('__createTestHandoff', activation => {
    const id = (handoffSequence === 0 ? 'd' : 'e').repeat(64);
    handoffSequence += 1;
    handoffs.set(id, {
      returnURL,
      trustedOrigin: 'https://oa.example.test',
      sourceURL: activation.sourceURL,
      sourcePath,
      title: activation.title,
      filename: 'Quarterly Report.DOCX',
      expectedFormat: 'docx',
      gatewayTemplate: 'https://gateway.example.test/wps/document?fileurl={sourcePath}',
      sourceIdentity,
      createdAt: Date.now() - 100,
      expiresAt: Date.now() + 120_000
    });
    return id;
  });
  await page.exposeFunction('__consumeTestHandoff', id => {
    const value = handoffs.get(id);
    handoffs.delete(id);
    return value;
  });

  await page.addInitScript(({ returnURL, sourceIdentity }) => {
    const observations = { configurationReady: false, openCalls: [], overwriteCalls: [] };
    globalThis.__roadFlowObservations = observations;
    globalThis.RoadFlowSourceIdentity = {
      async derive() { return { ok: true, identity: sourceIdentity }; }
    };
    const application = {
      ActiveDocument: {
        saveURL_FormData(url, metadata) {
          observations.overwriteCalls.push({ url, metadata });
          return true;
        }
      },
      openDocument(url, readOnly) {
        observations.openCalls.push({ url, readOnly });
        return true;
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
            if (message.type === 'configuration') {
              observations.configurationReady = true;
              return { ok: true, configuration: { trustedOrigin: 'https://oa.example.test' } };
            }
            if (message.type === 'claim-reverification') return { ok: false };
            if (message.type === 'create-editor-handoff') {
              const id = await globalThis.__createTestHandoff(message.activation);
              return { ok: true, editorURL: `https://oa.example.test/editor.html?handoff=${id}` };
            }
            if (message.type === 'consume-editor-handoff') {
              const handoff = await globalThis.__consumeTestHandoff(message.handoffID);
              return handoff ? { ok: true, handoff } : { ok: false };
            }
            return { ok: false };
          }
        },
        storage: { onChanged: { addListener() {} } }
      }
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async url => {
        const id = new URL(url).searchParams.get('handoff');
        return {
          ok: true,
          status: 200,
          async json() {
            return { handoff: id, ...sourceIdentity, deliveredAt: new Date().toISOString() };
          }
        };
      }
    });
    globalThis.__roadFlowReturnURL = returnURL;
  }, { returnURL, sourceIdentity });

  const assetNames = new Set([
    'content.js', 'editor.css', 'editor.html', 'editor.js',
    'identity-gate.js', 'source-identity-contract.js'
  ]);
  await page.route('https://oa.example.test/**', async route => {
    const url = new URL(route.request().url());
    const assetName = url.pathname.slice(1);
    if (url.pathname === '/workflow/current') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><a href="${sourcePath}">Quarterly Report</a><script src="/content.js"></script></body></html>`
      });
      return;
    }
    if (assetNames.has(assetName)) {
      const body = await readFile(new URL(`./${assetName}`, import.meta.url));
      const contentType = assetName.endsWith('.html') ? 'text/html' :
        assetName.endsWith('.css') ? 'text/css' : 'text/javascript';
      await route.fulfill({ contentType, body });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });

  await page.goto(returnURL);
  await page.waitForFunction(() => globalThis.__roadFlowObservations.configurationReady);
  return { returnURL };
}

test('the public OA workflow stays in one tab and reopens through a fresh handoff', async ({ page, context }) => {
  const { returnURL } = await openPublicWorkflow(page);

  await page.getByRole('link', { name: 'Quarterly Report' }).click();
  await expect(page).toHaveURL(new RegExp(`editor\\.html\\?handoff=${'d'.repeat(64)}$`));
  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  expect(context.pages()).toHaveLength(1);

  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('#editor-status')).toHaveText('已保存');
  await page.getByRole('button', { name: '返回 OA' }).click();
  await expect(page).toHaveURL(returnURL);
  await page.waitForFunction(() => globalThis.__roadFlowObservations.configurationReady);

  await page.getByRole('link', { name: 'Quarterly Report' }).click();
  await expect(page).toHaveURL(new RegExp(`editor\\.html\\?handoff=${'e'.repeat(64)}$`));
  await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
  expect(context.pages()).toHaveLength(1);
});

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
