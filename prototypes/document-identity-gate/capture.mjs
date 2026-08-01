import fs from "node:fs/promises";

const endpoint = process.argv[2];
const outputDir = process.argv[3];
const extensionOrigin = "chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb";
const serverOrigin = "http://127.0.0.1:49250";
const captureRunId = `capture-${Date.now()}`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function targets() {
  return fetch(`${endpoint}/json/list`).then((response) => response.json());
}

async function waitForTarget(predicate, attempts = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const target = (await targets()).find(predicate);
      if (target) return target;
    } catch (_) {
      // Qaxbrowser's debugging endpoint may still be starting.
    }
    await delay(500);
  }
  throw new Error("Timed out waiting for Qaxbrowser target");
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)));
    else handlers.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return {
    opened,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await delay(1200);
}

async function evidence() {
  return fetch(`${serverOrigin}/__evidence`).then((response) => response.json());
}

function overwriteCount(snapshot) {
  return snapshot.requests.filter((request) => request.overwrite).length;
}

async function waitForPhase(editor, phases, attempts = 80) {
  let state = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    state = await evaluate(editor, "window.__PROTOTYPE_STATE__ || null");
    if (state && phases.includes(state.phase)) return state;
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${phases.join("/")}: ${JSON.stringify(state)}`);
}

async function editorControls(editor) {
  return evaluate(editor, `({
    saveDisabled: document.querySelector('#save').disabled,
    retryDisabled: document.querySelector('#retry').disabled,
    returnDisabled: document.querySelector('#return').disabled,
    containerClass: document.querySelector('#wps-container').className,
    objectCount: document.querySelectorAll('#wps-container object').length,
    objectRect: (() => { const node = document.querySelector('#wps-container object'); if (!node) return null; const r = node.getBoundingClientRect(); return { width:r.width, height:r.height, left:r.left, top:r.top }; })()
  })`);
}

async function extensionDiagnostics() {
  const version = await fetch(`${endpoint}/json/version`).then((response) => response.json());
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.opened;
  const created = await browser.send("Target.createTarget", { url: "chrome://extensions/" });
  const target = await waitForTarget((candidate) => candidate.id === created.targetId);
  const page = connect(target.webSocketDebuggerUrl);
  await page.opened;
  await delay(1200);
  const data = await evaluate(page, `(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager && manager.shadowRoot.querySelector('extensions-item-list');
    const items = list ? Array.from(list.shadowRoot.querySelectorAll('extensions-item')) : [];
    return items.map(item => ({ id:item.data?.id, name:item.data?.name, state:item.data?.state,
      disableReasons:item.data?.disableReasons, runtimeWarnings:item.data?.runtimeWarnings,
      manifestErrors:item.data?.manifestErrors, installWarnings:item.data?.installWarnings }));
  })()`);
  await browser.send("Target.closeTarget", { targetId: created.targetId });
  page.close();
  browser.close();
  return data;
}

async function closeEditor(editor, targetId) {
  await evaluate(editor, "document.querySelector('#return').click(); true");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await targets()).some((target) => target.id === targetId)) return;
    await delay(200);
  }
  throw new Error("Editor tab did not close on Return to OA");
}

const initial = await waitForTarget((target) => target.type === "page");
const oa = connect(initial.webSocketDebuggerUrl);
await oa.opened;

async function openScenario(scenario) {
  await navigate(oa, `${serverOrigin}/oa/session/start?case=${encodeURIComponent(scenario)}&run=${encodeURIComponent(captureRunId)}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const readiness = await evaluate(oa, "document.documentElement.dataset.identityGateBackground || null");
    if (readiness === "ready") break;
    if (readiness === "failed" || attempt === 39) throw new Error(`Extension background readiness failed: ${readiness}`);
    await delay(250);
  }
  if (scenario === "missing-session") {
    await evaluate(oa, "fetch('/oa/session/clear', { credentials:'same-origin' }).then(r => r.text())");
  }
  const beforeTargets = new Set((await targets()).map((target) => target.id));
  await evaluate(oa, "document.querySelector('#document-link').click(); true");
  let editorTarget;
  try {
    editorTarget = await waitForTarget((target) => target.type === "page" && !beforeTargets.has(target.id)
      && target.url.startsWith(`${extensionOrigin}/editor.html?editorSessionId=`), 30);
  } catch (error) {
    const debug = {
      scenario,
      oaUrl: await evaluate(oa, "location.href"),
      interceptor: await evaluate(oa, "({ state: document.documentElement.dataset.identityGate || null, error: document.documentElement.dataset.identityGateError || null })"),
      targets: await targets(),
      extensions: await extensionDiagnostics()
    };
    await fs.writeFile(`${outputDir}/interception-failure.json`, `${JSON.stringify(debug, null, 2)}\n`);
    throw new Error(`Editor tab was not created: ${JSON.stringify(debug)}`);
  }
  const editor = connect(editorTarget.webSocketDebuggerUrl);
  await editor.opened;
  return { editor, editorTarget };
}

async function captureScenario(scenario, expectedPhase, { save = false } = {}) {
  const before = await evidence();
  const { editor, editorTarget } = await openScenario(scenario);
  let state = await waitForPhase(editor, [expectedPhase, expectedPhase === "ready" ? "failed" : "ready"]);
  const phaseBeforeSaveProbe = state.phase;
  const controlsBeforeSaveProbe = await editorControls(editor);
  if (save && state.phase === "ready") {
    await evaluate(editor, "document.querySelector('#save').click(); true");
    state = await waitForPhase(editor, ["saved", "failed"], 40);
  } else if (state.phase === "failed") {
    await evaluate(editor, "document.querySelector('#save').click(); true");
    await delay(400);
    state = await evaluate(editor, "window.__PROTOTYPE_STATE__");
  } else {
    state = await evaluate(editor, "window.__PROTOTYPE_STATE__");
  }
  const screenshot = await editor.send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(`${outputDir}/${scenario}.png`, screenshot.data, "base64");
  const controlsAfterSaveProbe = await editorControls(editor);
  const after = await evidence();
  await closeEditor(editor, editorTarget.id);
  editor.close();
  return {
    scenario,
    expectedPhase,
    phaseBeforeSaveProbe,
    finalState: state,
    controlsBeforeSaveProbe,
    controlsAfterSaveProbe,
    overwritePostsBefore: overwriteCount(before),
    overwritePostsAfter: overwriteCount(after),
    gatewayRequests: after.requests.filter((request) => request.gateway && request.scenario === scenario),
    sourceRequests: after.requests.filter((request) => request.directSource && request.scenario === scenario)
  };
}

const cases = [];
cases.push(await captureScenario("success", "ready", { save: true }));
cases.push(await captureScenario("missing-session", "failed"));
cases.push(await captureScenario("error-page", "failed"));
cases.push(await captureScenario("wrong-document", "failed"));
cases.push(await captureScenario("missing-receipt", "failed"));
cases.push(await captureScenario("mismatch", "failed"));
cases.push(await captureScenario("timeout", "failed"));
cases.push(await captureScenario("stale-seed", "ready"));
cases.push(await captureScenario("stale-cache", "failed"));

const retryBefore = await evidence();
const retryOpened = await openScenario("fresh-retry");
const firstRetryState = await waitForPhase(retryOpened.editor, ["failed"]);
const firstRetryControls = await editorControls(retryOpened.editor);
await evaluate(retryOpened.editor, "document.querySelector('#retry').click(); true");
let secondRetryState = null;
for (let attempt = 0; attempt < 80; attempt += 1) {
  secondRetryState = await evaluate(retryOpened.editor, "window.__PROTOTYPE_STATE__ || null");
  if (secondRetryState && secondRetryState.handoffId !== firstRetryState.handoffId
      && ["ready", "failed"].includes(secondRetryState.phase)) break;
  await delay(300);
}
if (!secondRetryState || secondRetryState.handoffId === firstRetryState.handoffId
    || !["ready", "failed"].includes(secondRetryState.phase)) {
  throw new Error(`Fresh retry did not reach a terminal state: ${JSON.stringify(secondRetryState)}`);
}
const secondRetryControls = await editorControls(retryOpened.editor);
const retryScreenshot = await retryOpened.editor.send("Page.captureScreenshot", { format: "png" });
await fs.writeFile(`${outputDir}/fresh-retry.png`, retryScreenshot.data, "base64");
const retryAfter = await evidence();
await closeEditor(retryOpened.editor, retryOpened.editorTarget.id);
retryOpened.editor.close();

const retry = {
  scenario: "fresh-retry",
  firstState: firstRetryState,
  secondState: secondRetryState,
  firstControls: firstRetryControls,
  secondControls: secondRetryControls,
  overwritePostsBefore: overwriteCount(retryBefore),
  overwritePostsAfter: overwriteCount(retryAfter)
};

const browserTarget = await fetch(`${endpoint}/json/version`).then((response) => response.json());
const finalEvidence = await evidence();
const byScenario = Object.fromEntries(cases.map((entry) => [entry.scenario, entry]));
const failureNames = ["missing-session", "error-page", "wrong-document", "missing-receipt", "mismatch", "timeout", "stale-cache"];
const assertions = {
  targetBrowserIsQaxChromium102: browserTarget.Browser.includes("Chrome/102.0.5005.200"),
  successReadUsedOaSession: byScenario.success.sourceRequests.some((request) => request.status === 200 && request.cookie.includes("oa_session=")),
  successIdentityExactlyMatched: byScenario.success.phaseBeforeSaveProbe === "ready"
    && byScenario.success.finalState.sourceIdentity.sha256 === byScenario.success.finalState.gatewayReceipt.sha256
    && byScenario.success.finalState.sourceIdentity.bytes === byScenario.success.finalState.gatewayReceipt.bytes
    && byScenario.success.finalState.sourceIdentity.format === byScenario.success.finalState.gatewayReceipt.format,
  editingAndSaveUnlockedOnlyAfterPass: byScenario.success.controlsBeforeSaveProbe.containerClass === "unlocked"
    && byScenario.success.controlsBeforeSaveProbe.saveDisabled === false
    && failureNames.every((name) => byScenario[name].controlsBeforeSaveProbe.containerClass === "locked"
      && byScenario[name].controlsBeforeSaveProbe.saveDisabled === true
      && byScenario[name].controlsBeforeSaveProbe.objectCount === 0),
  missingSessionFailedAtAuthenticatedSourceRead: byScenario["missing-session"].finalState.error.includes("HTTP 401")
    && byScenario["missing-session"].sourceRequests.some((request) => request.status === 401 && request.cookie === ""),
  htmlErrorPageRejectedByActualFormat: byScenario["error-page"].finalState.error.includes("unknown, expected DOCX"),
  wrongValidDocumentRejected: byScenario["wrong-document"].finalState.error.includes("wrong byte count")
    || byScenario["wrong-document"].finalState.error.includes("wrong SHA-256"),
  missingReceiptTimedOut: byScenario["missing-receipt"].finalState.error.includes("did not arrive"),
  falsifiedReceiptRejected: byScenario.mismatch.finalState.error.includes("wrong SHA-256"),
  delayedReceiptTimedOut: byScenario.timeout.finalState.error.includes("did not arrive"),
  staleCacheAttemptHadNoUsableReceipt: byScenario["stale-cache"].finalState.error.includes("did not arrive"),
  allScenariosReachedExpectedPhase: cases.every((entry) => entry.phaseBeforeSaveProbe === entry.expectedPhase),
  staleCacheWasSeededThenReusedWithoutGet: byScenario["stale-seed"].gatewayRequests.length === 1
    && byScenario["stale-cache"].gatewayRequests.length === 0,
  everyFailedGatePreventedOverwrite: failureNames.every((name) => byScenario[name].overwritePostsAfter === byScenario[name].overwritePostsBefore),
  successfulGateAllowedOverwrite: byScenario.success.overwritePostsAfter === byScenario.success.overwritePostsBefore + 1
    && byScenario.success.finalState.phase === "saved",
  retryUsedFreshHandoff: firstRetryState.handoffId !== secondRetryState.handoffId && secondRetryState.attempt === firstRetryState.attempt + 1,
  retryFailedClosedThenPassed: firstRetryState.phase === "failed" && firstRetryControls.saveDisabled === true
    && firstRetryControls.objectCount === 0 && secondRetryState.phase === "ready"
    && secondRetryControls.saveDisabled === false && secondRetryControls.containerClass === "unlocked",
  retryDidNotOverwrite: retry.overwritePostsAfter === retry.overwritePostsBefore
};

const result = {
  capturedAt: new Date().toISOString(),
  machine: { platform: process.platform, arch: process.arch, browser: browserTarget.Browser },
  extensionOrigin,
  cases,
  retry,
  gatewayRequestSummary: finalEvidence.requests.filter((request) => request.gateway).map((request) => ({
    scenario: request.scenario, handoff: request.handoff, cacheKey: request.cacheKey,
    bytes: request.bytes, sha256: request.sha256, userAgent: request.userAgent
  })),
  assertions
};
await fs.writeFile(`${outputDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
oa.close();
console.log(JSON.stringify({ capturedAt: result.capturedAt, machine: result.machine, assertions, result: `${outputDir}/result.json` }, null, 2));

if (Object.values(assertions).some((value) => value !== true)) {
  process.exitCode = 1;
}
