(async function runDocumentIdentityGatePrototype() {
  "use strict";

  const MIME_TYPE = "application/x-wps";
  const RECEIPT_TIMEOUT_MS = 3000;
  const RECEIPT_MAX_AGE_MS = 15000;
  const serverOrigin = "http://127.0.0.1:49250";
  const output = document.getElementById("state-output");
  const status = document.getElementById("status");
  const banner = document.getElementById("gate-banner");
  const saveButton = document.getElementById("save");
  const retryButton = document.getElementById("retry");
  const returnButton = document.getElementById("return");
  const container = document.getElementById("wps-container");
  let state = DocumentIdentityGate.initialState();
  let currentAttempt = null;
  let object = null;
  let application = null;

  function dispatch(event) {
    state = DocumentIdentityGate.reduce(state, event);
    document.body.dataset.phase = state.phase;
    status.textContent = state.phase + (state.error ? ": " + state.error : "");
    banner.textContent = state.gate.status === "passed"
      ? "Document Identity Gate 已通过：编辑和保存已解锁。"
      : `Document Identity Gate ${state.gate.status === "failed" ? "失败" : "已锁定"}：${state.gate.reason}`;
    saveButton.disabled = !state.controls.save;
    retryButton.disabled = !state.controls.retry;
    returnButton.disabled = !state.controls.return;
    output.textContent = JSON.stringify(state, null, 2);
    window.__PROTOTYPE_STATE__ = state;
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else if (!response || !response.ok) reject(new Error(response?.error || "Extension operation failed"));
        else resolve(response);
      });
    });
  }

  function resolveGateway(template, sourcePath, cacheKey) {
    if (template.split("{sourcePath}").length !== 2) throw new Error("Gateway template must contain {sourcePath} exactly once");
    const resolved = template.replace("{sourcePath}", encodeURIComponent(sourcePath));
    return resolved + (resolved.includes("?") ? "&" : "?") + "_wpsHandoff=" + encodeURIComponent(cacheKey);
  }

  function destroyWps() {
    application = null;
    object = null;
    container.className = "locked";
    container.replaceChildren();
  }

  function fail(error) {
    destroyWps();
    dispatch({ type: "failed", error: String(error.message || error) });
  }

  function mountWps() {
    object = document.createElement("object");
    object.id = "webwps";
    object.name = "webwps";
    object.type = MIME_TYPE;
    object.setAttribute("hiden_taskpane", "true");
    const enabled = document.createElement("param");
    enabled.name = "Enabled";
    enabled.value = "1";
    object.appendChild(enabled);
    container.className = "locked";
    container.replaceChildren(object);
  }

  async function waitForApplication() {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (typeof object.Application === "function" || typeof object.Application === "object") return object.Application;
      } catch (_) {
        // WPS NPAPI starts asynchronously.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("WPS Application was not exposed by application/x-wps");
  }

  async function waitForActiveDocument() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (application.ActiveDocument) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("WPS reported no ActiveDocument after Gateway open");
  }

  function receiptMatches(receipt, identity, handoffId) {
    if (receipt.handoff !== handoffId) return "Gateway Delivery Receipt has the wrong Editor Handoff";
    if (receipt.sourcePath !== identity.sourcePath) return "Gateway Delivery Receipt has the wrong sourcePath";
    if (receipt.format !== identity.format) return "Gateway Delivery Receipt has the wrong actual format";
    if (receipt.bytes !== identity.bytes) return "Gateway Delivery Receipt has the wrong byte count";
    if (receipt.sha256 !== identity.sha256) return "Gateway Delivery Receipt has the wrong SHA-256";
    const deliveredAt = Date.parse(receipt.deliveredAt);
    if (!Number.isFinite(deliveredAt) || Date.now() - deliveredAt > RECEIPT_MAX_AGE_MS || deliveredAt > Date.now() + 1000) {
      return "Gateway Delivery Receipt is stale or malformed";
    }
    return null;
  }

  async function pollReceipt(handoffId) {
    const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await fetch(`${serverOrigin}/wps/v1/delivery-receipt?handoff=${encodeURIComponent(handoffId)}`, { cache: "no-store" });
      if (response.ok) return response.json();
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Gateway Delivery Receipt did not arrive before the verification timeout");
  }

  async function beginAttempt() {
    destroyWps();
    const editorSessionId = new URLSearchParams(location.search).get("editorSessionId");
    if (!editorSessionId) throw new Error("Editor session ID is missing");
    const response = await runtimeMessage({ type: "begin-verification-attempt", editorSessionId });
    currentAttempt = response.attempt;
    dispatch({ type: "attempt-started", attempt: currentAttempt.attempt, handoffId: currentAttempt.handoffId });
    document.getElementById("document-title").textContent = currentAttempt.title || currentAttempt.sourcePath;
    if (currentAttempt.sourceError) throw new Error(currentAttempt.sourceError);

    const cacheKey = ["stale-seed", "stale-cache"].includes(currentAttempt.scenario)
      ? "ticket-42-stable-cache-" + currentAttempt.cacheRunId
      : currentAttempt.handoffId;
    const gatewayUrl = resolveGateway(currentAttempt.gatewayTemplate, currentAttempt.sourcePath, cacheKey);
    const prepareUrl = `${serverOrigin}/__prepare?handoff=${encodeURIComponent(currentAttempt.handoffId)}&cacheKey=${encodeURIComponent(cacheKey)}&sourcePath=${encodeURIComponent(currentAttempt.sourcePath)}&case=${encodeURIComponent(currentAttempt.scenario)}`;
    const prepared = await fetch(prepareUrl, { cache: "no-store" });
    if (!prepared.ok) throw new Error("Gateway refused to prepare receipt observation");
    dispatch({ type: "source-identified", identity: currentAttempt.sourceIdentity, gatewayUrl });

    mountWps();
    application = await waitForApplication();
    dispatch({ type: "plugin-ready", plugin: { mimeType: MIME_TYPE, applicationName: application.Name } });
    const openResult = application.openDocument(gatewayUrl, false);
    if (openResult === false) throw new Error("WPS openDocument returned false");
    await waitForActiveDocument();
    dispatch({ type: "document-opened", result: openResult });
    const receipt = await pollReceipt(currentAttempt.handoffId);
    const mismatch = receiptMatches(receipt, currentAttempt.sourceIdentity, currentAttempt.handoffId);
    if (mismatch) throw new Error(mismatch);
    container.className = "unlocked";
    window.__WPS_APPLICATION__ = application;
    dispatch({ type: "gate-passed", receipt });
  }

  saveButton.addEventListener("click", async () => {
    if (state.phase !== "ready" && state.phase !== "saved") return;
    dispatch({ type: "save-started" });
    try {
      const saveUrl = currentAttempt.oaOrigin + currentAttempt.savePath + "?fileurl=" + encodeURIComponent(currentAttempt.sourcePath);
      const result = application.ActiveDocument.saveURL_FormData(saveUrl, "formId:formeditor;sourcePath:" + encodeURIComponent(currentAttempt.sourcePath));
      if (result === false) throw new Error("WPS saveURL_FormData returned false");
      dispatch({ type: "save-finished", result });
    } catch (error) {
      fail(error);
    }
  });

  retryButton.addEventListener("click", () => {
    retryButton.disabled = true;
    beginAttempt().catch(fail);
  });

  returnButton.addEventListener("click", async () => {
    dispatch({ type: "return-started" });
    try {
      destroyWps();
      await runtimeMessage({ type: "return-to-origin" });
    } catch (error) {
      fail(error);
    }
  });

  dispatch({ type: "prototype-started" });
  beginAttempt().catch(fail);
})();
