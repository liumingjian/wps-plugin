import fs from "node:fs/promises";

const endpoint = process.argv[2];
const outputDir = process.argv[3];
const extensionOrigin = "chrome-extension://mjjoapeohdfkepmocpahbimmmenlfdcb";
const marker = `ticket-40 gateway-flow ${new Date().toISOString()}`;

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
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await delay(1500);
}

const initial = await waitForTarget((target) => target.type === "page");
const oa = connect(initial.webSocketDebuggerUrl);
await oa.opened;
await navigate(oa, "http://127.0.0.1:49240/oa/session/start");
await delay(1000);
const oaUrlBefore = await evaluate(oa, "location.href");
await evaluate(oa, "document.querySelector('#document-link').click(); true");

let editorTarget;
try {
  editorTarget = await waitForTarget((target) => target.type === "page" && target.url.startsWith(`${extensionOrigin}/editor.html?handoffId=`), 24);
} catch (error) {
  const debug = {
    oaUrl: await evaluate(oa, "location.href"),
    interceptorState: await evaluate(oa, "({ state: document.documentElement.dataset.gatewayFlow || null, error: document.documentElement.dataset.gatewayFlowError || null })"),
    targets: await targets()
  };
  await fs.writeFile(`${outputDir}/interception-failure.json`, `${JSON.stringify(debug, null, 2)}\n`);
  throw new Error(`Editor tab was not created: ${JSON.stringify(debug)}`);
}
const editorUrl = editorTarget.url;
const editor = connect(editorTarget.webSocketDebuggerUrl);
await editor.opened;
let state = null;
for (let attempt = 0; attempt < 70; attempt += 1) {
  state = await evaluate(editor, "window.__PROTOTYPE_STATE__ || null");
  if (state && (state.phase === "ready" || state.phase === "failed")) break;
  await delay(500);
}
if (!state || state.phase !== "ready") throw new Error(`Editor did not become ready: ${JSON.stringify(state)}`);

await evaluate(editor, `window.__WPS_APPLICATION__.Selection.TypeText(${JSON.stringify(marker)}); true`);
await evaluate(editor, "document.querySelector('#save').click(); true");
for (let attempt = 0; attempt < 30; attempt += 1) {
  state = await evaluate(editor, "window.__PROTOTYPE_STATE__ || null");
  if (state && (state.phase === "saved" || state.phase === "failed")) break;
  await delay(500);
}
const screenshot = await editor.send("Page.captureScreenshot", { format: "png" });
await fs.writeFile(`${outputDir}/editor-saved.png`, screenshot.data, "base64");
const savedState = state;
await evaluate(editor, "document.querySelector('#return').click(); true");
await delay(2500);
const remainingTargets = await targets();
const editorClosed = !remainingTargets.some((target) => target.id === editorTarget.id);
const oaUrlAfter = await evaluate(oa, "location.href");
const oaVisibilityAfter = await evaluate(oa, "document.visibilityState");

const browserTarget = await fetch(`${endpoint}/json/version`).then((response) => response.json());
const browser = connect(browserTarget.webSocketDebuggerUrl);
await browser.opened;
const duplicate = await browser.send("Target.createTarget", { url: editorUrl });
const duplicateTarget = await waitForTarget((target) => target.id === duplicate.targetId);
const duplicateEditor = connect(duplicateTarget.webSocketDebuggerUrl);
await duplicateEditor.opened;
let duplicateState = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  duplicateState = await evaluate(duplicateEditor, "window.__PROTOTYPE_STATE__ || null");
  if (duplicateState && duplicateState.phase === "failed") break;
  await delay(250);
}
await browser.send("Target.closeTarget", { targetId: duplicate.targetId });

const server = await fetch(`http://127.0.0.1:49240/__evidence?marker=${encodeURIComponent(marker)}`).then((response) => response.json());
const gatewayRequests = server.requests.filter((request) => request.gateway);
const saveRequests = server.requests.filter((request) => request.method === "POST" && request.path.startsWith("/RoadFlow/uploadfiles/OfficeSave"));
const result = {
  capturedAt: new Date().toISOString(),
  browser: browserTarget.Browser,
  extensionOrigin,
  marker,
  oa: { before: oaUrlBefore, after: oaUrlAfter, visibilityAfterReturn: oaVisibilityAfter, editorClosed },
  editor: { url: editorUrl, savedState, duplicateConsumptionState: duplicateState },
  server: { gatewayRequests, saveRequests, artifact: server.artifact },
  assertions: {
    interceptedIntoPackagedEditor: editorUrl.startsWith(`${extensionOrigin}/editor.html?handoffId=`),
    sourcePathPreserved: savedState.sourcePath === "/UploadFiles/2026/quarterly-report.docx",
    gatewayTemplateResolved: savedState.gatewayUrl.startsWith("http://127.0.0.1:49240/wps/v1/document?fileurl=%2FUploadFiles%2F2026%2Fquarterly-report.docx&_wpsHandoff="),
    authenticatedOverwriteSucceeded: saveRequests.some((request) => request.status === 200 && request.auth === "accepted"),
    savedEditPresentInStoredDocument: server.artifact.markerPresent === true,
    gatewayReadNeededNoCookie: gatewayRequests.some((request) => request.status === 200 && request.cookie === ""),
    handoffWasSingleUse: duplicateState && duplicateState.phase === "failed" && duplicateState.error.includes("already consumed"),
    returnedToStillOpenOaTab: editorClosed && oaUrlAfter.endsWith("/oa") && oaVisibilityAfter === "visible",
    limitationStillExplicit: savedState.integrityGate.startsWith("DEFERRED")
  }
};
await fs.writeFile(`${outputDir}/result.json`, `${JSON.stringify(result, null, 2)}\n`);
editor.close();
oa.close();
duplicateEditor.close();
browser.close();
console.log(JSON.stringify(result, null, 2));
