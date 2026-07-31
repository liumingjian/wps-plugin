"use strict";

const INTEGRATIONS = {
  "http://127.0.0.1:49240": {
    gatewayTemplate: "http://127.0.0.1:49240/wps/v1/document?fileurl={sourcePath}",
    savePath: "/RoadFlow/uploadfiles/OfficeSave"
  }
};
const consuming = new Set();

function editorSender(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  return url.origin === location.origin && url.pathname === "/editor.html";
}

function sessionGet(key) {
  return chrome.storage.session.get(key).then((result) => result[key]);
}

async function createHandoff(request, sender) {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) throw new Error("Document Link has no originating tab");
  const pageUrl = new URL(sender.tab.url);
  const sourceUrl = new URL(request.sourceUrl);
  const integration = INTEGRATIONS[pageUrl.origin];
  if (!integration || sourceUrl.origin !== pageUrl.origin || sourceUrl.pathname !== request.sourcePath) throw new Error("Document Link is outside the configured OA integration");

  const handoffId = crypto.randomUUID();
  const handoff = {
    handoffId,
    sourcePath: request.sourcePath,
    title: request.title,
    oaOrigin: pageUrl.origin,
    originTabId: sender.tab.id,
    gatewayTemplate: integration.gatewayTemplate,
    savePath: integration.savePath,
    createdAt: new Date().toISOString()
  };
  await chrome.storage.session.set({ ["handoff:" + handoffId]: handoff });
  await chrome.tabs.create({ url: chrome.runtime.getURL("editor.html?handoffId=" + encodeURIComponent(handoffId)), active: true });
  return { ok: true };
}

async function consumeHandoff(request, sender) {
  if (!editorSender(sender) || !sender.tab || typeof request.handoffId !== "string") throw new Error("Invalid Editor Handoff consumer");
  const key = "handoff:" + request.handoffId;
  if (consuming.has(key)) throw new Error("Editor Handoff is already being consumed");
  consuming.add(key);
  try {
    const handoff = await sessionGet(key);
    if (!handoff) throw new Error("Editor Handoff is missing, expired, or already consumed");
    await chrome.storage.session.remove(key);
    await chrome.storage.session.set({ ["return:" + sender.tab.id]: {
      originTabId: handoff.originTabId,
      oaOrigin: handoff.oaOrigin
    } });
    return { ok: true, handoff };
  } finally {
    consuming.delete(key);
  }
}

async function returnToOrigin(sender) {
  if (!editorSender(sender) || !sender.tab) throw new Error("Return must come from the editor tab");
  const key = "return:" + sender.tab.id;
  const context = await sessionGet(key);
  if (!context) throw new Error("Return context is missing");
  const target = await chrome.tabs.get(context.originTabId);
  if (new URL(target.url).origin !== context.oaOrigin) throw new Error("Originating OA tab changed Origin");
  await chrome.tabs.update(target.id, { active: true });
  if (Number.isInteger(target.windowId)) await chrome.windows.update(target.windowId, { focused: true });
  await chrome.storage.session.remove(key);
  await chrome.tabs.remove(sender.tab.id);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  let operation;
  if (request && request.type === "intercept-document-link") operation = createHandoff(request, sender);
  else if (request && request.type === "consume-editor-handoff") operation = consumeHandoff(request, sender);
  else if (request && request.type === "return-to-origin") operation = returnToOrigin(sender);
  else return false;

  operation.then(respond).catch((error) => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
