"use strict";

const INTEGRATIONS = {
  "http://127.0.0.1:49250": {
    gatewayTemplate: "http://127.0.0.1:49250/wps/v1/document?fileurl={sourcePath}",
    savePath: "/RoadFlow/uploadfiles/OfficeSave"
  }
};

function storageGet(key) {
  return chrome.storage.session.get(key).then((result) => result[key]);
}

function editorSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.tab) return false;
  const url = new URL(sender.url);
  return url.origin === location.origin && url.pathname === "/editor.html";
}

function tabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else if (!response || !response.ok) reject(new Error(response?.error || "OA source reader failed"));
      else resolve(response);
    });
  });
}

async function createEditorSession(request, sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error("Document Link has no originating tab");
  const pageUrl = new URL(sender.tab.url);
  const sourceUrl = new URL(request.sourceUrl);
  const integration = INTEGRATIONS[pageUrl.origin];
  if (!integration || sourceUrl.origin !== pageUrl.origin || sourceUrl.pathname !== request.sourcePath) {
    throw new Error("Document Link is outside the configured OA integration");
  }
  const editorSessionId = crypto.randomUUID();
  const context = {
    editorSessionId,
    originTabId: sender.tab.id,
    originUrl: sender.tab.url,
    oaOrigin: pageUrl.origin,
    sourceUrl: sourceUrl.href,
    sourcePath: request.sourcePath,
    scenario: sourceUrl.searchParams.get("case") || "success",
    cacheRunId: sourceUrl.searchParams.get("run") || "manual",
    title: request.title,
    gatewayTemplate: integration.gatewayTemplate,
    savePath: integration.savePath,
    attempts: 0
  };
  await chrome.storage.session.set({ ["editor:" + editorSessionId]: context });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html?editorSessionId=" + encodeURIComponent(editorSessionId)), active: true });
  return { ok: true };
}

async function beginAttempt(request, sender) {
  if (!editorSender(sender) || typeof request.editorSessionId !== "string") throw new Error("Invalid editor attempt");
  const key = "editor:" + request.editorSessionId;
  const context = await storageGet(key);
  if (!context) throw new Error("Editor session is missing");
  context.attempts += 1;
  const handoffId = crypto.randomUUID();
  const scenario = context.scenario === "fresh-retry" && context.attempts > 1 ? "success" : context.scenario;
  await chrome.storage.session.set({ [key]: context, ["return:" + sender.tab.id]: context });
  try {
    const response = await tabMessage(context.originTabId, {
      type: "read-source-identity",
      sourceUrl: context.sourceUrl,
      sourcePath: context.sourcePath
    });
    return { ok: true, attempt: { handoffId, scenario, attempt: context.attempts, sourceIdentity: response.identity,
      sourcePath: context.sourcePath, title: context.title, oaOrigin: context.oaOrigin,
      gatewayTemplate: context.gatewayTemplate, savePath: context.savePath, cacheRunId: context.cacheRunId } };
  } catch (error) {
    return { ok: true, attempt: { handoffId, scenario, attempt: context.attempts, sourcePath: context.sourcePath,
      title: context.title, sourceError: String(error.message || error) } };
  }
}

async function returnToOrigin(sender) {
  if (!editorSender(sender)) throw new Error("Return must come from the editor tab");
  const key = "return:" + sender.tab.id;
  const context = await storageGet(key);
  if (!context) throw new Error("Return context is missing");
  const target = await chrome.tabs.get(context.originTabId);
  if (new URL(target.url).origin !== context.oaOrigin) throw new Error("Originating OA tab changed Origin");
  await chrome.tabs.update(target.id, { active: true });
  if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
  await chrome.storage.session.remove([key, "editor:" + context.editorSessionId]);
  await chrome.tabs.remove(sender.tab.id);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  let operation;
  if (request?.type === "prototype-readiness-ping") operation = Promise.resolve({ ok: true });
  else if (request?.type === "intercept-document-link") operation = createEditorSession(request, sender);
  else if (request?.type === "begin-verification-attempt") operation = beginAttempt(request, sender);
  else if (request?.type === "return-to-origin") operation = returnToOrigin(sender);
  else return false;
  operation.then(respond).catch((error) => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
