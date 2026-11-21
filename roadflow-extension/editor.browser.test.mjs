import { chromium, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const editorURL = pathToFileURL(fileURLToPath(new URL('./editor.html', import.meta.url))).href;
const handoffID = 'a'.repeat(64);
const extensionOrigin = 'chrome-extension://bojjhibgkhknccepabkojdjodhhgdjfd';

test('the installed extension verifies an authenticated DOC and replaces the OA page', async () => {
  const sourcePath = '/documents/Quarterly%20Report.DOC';
  const bytes = await readFile(new URL('../roadflowoa/testdata/original.doc', import.meta.url));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const delivered = new Map();
  let authenticatedReads = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/oa') {
      response.setHeader('Content-Type', 'text/html');
      response.setHeader('Set-Cookie', 'session=mock; HttpOnly; SameSite=Strict');
      response.end(`<a href="${sourcePath}">Quarterly Report</a>`);
    } else if (url.pathname === sourcePath && request.headers.cookie === 'session=mock') {
      authenticatedReads += 1;
      response.end(bytes);
    } else if (url.pathname === '/wps/document' && url.searchParams.get('fileurl') === sourcePath &&
        !request.headers.cookie) {
      const handoff = url.searchParams.get('_wpsHandoff');
      response.setHeader('Access-Control-Allow-Origin', extensionOrigin);
      response.end(bytes, () => {
        delivered.set(handoff, { handoff, sourcePath, actualFormat: 'doc', byteCount: bytes.length,
          sha256, deliveredAt: new Date().toISOString() });
      });
    } else if (url.pathname === '/wps/delivery-receipt' && request.method === 'POST' &&
        request.headers.origin === extensionOrigin) {
      const receipt = delivered.get(url.searchParams.get('handoff'));
      response.setHeader('Access-Control-Allow-Origin', extensionOrigin);
      response.setHeader('Content-Type', 'application/json');
      response.writeHead(receipt ? 200 : 204);
      response.end(receipt && JSON.stringify(receipt));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const staging = await mkdtemp(join(tmpdir(), 'roadflow-browser-'));
  let context;
  try {
    const extension = join(staging, 'extension');
    await cp(new URL('./', import.meta.url), extension, { recursive: true });
    const icon = await readFile(new URL('../extension/icon.png.base64', import.meta.url), 'ascii');
    await writeFile(join(extension, 'icon.png'), Buffer.from(icon, 'base64'));
    context = await chromium.launchPersistentContext(join(staging, 'profile'), {
      channel: 'chromium',
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async origin => {
      await chrome.storage.local.set({
        roadFlowIntegration: {
          trustedOrigin: origin,
          gatewayTemplate: `${origin}/wps/document?fileurl={sourcePath}`
        }
      });
    }, origin);
    await context.addInitScript(() => {
      Object.defineProperty(HTMLObjectElement.prototype, 'Application', {
        value: {
          ActiveDocument: {},
          openDocument(url) {
            void fetch(url, { credentials: 'omit' });
            return true;
          }
        }
      });
    });
    const [page] = context.pages();
    const returnURL = `${origin}/oa?step=review#document`;
    await page.goto(returnURL);
    await page.getByRole('link', { name: 'Quarterly Report' }).click();
    await expect(page).toHaveURL(new RegExp(`^${extensionOrigin}/editor\\.html\\?handoff=[a-f0-9]{64}$`));
    await expect(page.locator('#editor-status')).toHaveText('正文可编辑');
    expect(authenticatedReads).toBe(1);
    expect(delivered.size).toBe(1);
    expect(context.pages()).toHaveLength(1);
    await page.getByRole('button', { name: '返回 OA' }).click();
    await expect(page).toHaveURL(returnURL);
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(staging, { recursive: true, force: true });
  }
});

function installWPSBoundary(scenario) {
  const overwriteResults = [...(scenario.overwriteResults || [true])];
  const observations = { configurationReady: false, openCalls: [], overwriteCalls: [] };
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
}

async function openEditor(page, scenario = {}) {
  await page.addInitScript(installWPSBoundary, scenario);
  await page.addInitScript(({ handoffID, scenario }) => {
    const sourcePath = scenario.sourcePath || '/UploadFiles/2026/Quarterly%20Report.DOCX';
    const expectedFormat = sourcePath.toLowerCase().endsWith('.doc') ? 'doc' : 'docx';
    const sourceIdentity = {
      sourcePath,
      actualFormat: expectedFormat,
      byteCount: 4096,
      sha256: 'b'.repeat(64)
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
      value: async url => {
        const receipt = {
          handoff: handoffID,
          sourcePath: scenario.receiptMismatch ? '/UploadFiles/2026/Wrong.docx' : sourcePath,
          actualFormat: expectedFormat,
          byteCount: sourceIdentity.byteCount,
          sha256: sourceIdentity.sha256,
          deliveredAt: new Date().toISOString()
        };
        const response = Response.json(receipt);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      }
    });
  }, { handoffID, scenario });

  await page.goto(`${editorURL}?handoff=${handoffID}`);
}

async function openPublicWorkflow(page) {
  const returnURL = 'https://oa.example.test/workflow/current?step=review#document';
  const sourcePath = '/UploadFiles/2026/Quarterly%20Report.DOCX';
  const mockOAPage = await readFile(new URL('./testdata/mock-oa.html', import.meta.url));
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

  await page.addInitScript(installWPSBoundary, {});
  await page.addInitScript(({ returnURL, sourceIdentity }) => {
    const observations = globalThis.__roadFlowObservations;
    globalThis.RoadFlowSourceIdentity = {
      async derive() { return { ok: true, identity: sourceIdentity }; }
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
        const response = Response.json({ handoff: id, ...sourceIdentity, deliveredAt: new Date().toISOString() });
        Object.defineProperty(response, 'url', { value: url });
        return response;
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
        body: mockOAPage
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
