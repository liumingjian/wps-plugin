(async function runEditorPrototype() {
  "use strict";

  const MIME_TYPE = "application/x-wps";
  const output = document.getElementById("state-output");
  const status = document.getElementById("status");
  const saveButton = document.getElementById("save");
  const returnButton = document.getElementById("return");
  const container = document.getElementById("wps-container");
  let state = PrototypeFlow.initialFlow();
  let handoff = null;
  let object = null;
  let application = null;

  function dispatch(event) {
    state = PrototypeFlow.reduceFlow(state, event);
    document.body.dataset.phase = state.phase;
    status.textContent = state.phase + (state.error ? ": " + state.error : "");
    output.textContent = JSON.stringify(state, null, 2);
    window.__PROTOTYPE_STATE__ = state;
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else if (!response || !response.ok) reject(new Error(response && response.error ? response.error : "Extension operation failed"));
        else resolve(response);
      });
    });
  }

  function resolveGateway(template, sourcePath, handoffId) {
    if (template.split("{sourcePath}").length !== 2) throw new Error("Gateway template must contain {sourcePath} exactly once");
    const resolved = template.replace("{sourcePath}", encodeURIComponent(sourcePath));
    const separator = resolved.includes("?") ? "&" : "?";
    return resolved + separator + "_wpsHandoff=" + encodeURIComponent(handoffId);
  }

  function mountWps() {
    object = document.createElement("object");
    object.id = "webwps";
    object.name = "webwps";
    object.type = MIME_TYPE;
    object.width = "100%";
    object.height = "100%";
    object.setAttribute("hiden_taskpane", "true");
    const enabled = document.createElement("param");
    enabled.name = "Enabled";
    enabled.value = "1";
    object.appendChild(enabled);
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

  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    dispatch({ type: "save-started" });
    try {
      const result = application.ActiveDocument.saveURL_FormData(
        state.saveUrl,
        "formId:formeditor;sourcePath:" + encodeURIComponent(handoff.sourcePath)
      );
      if (result === false) throw new Error("WPS saveURL_FormData returned false");
      dispatch({ type: "save-finished", result });
    } catch (error) {
      dispatch({ type: "failed", error: String(error.message || error) });
    } finally {
      saveButton.disabled = false;
    }
  });

  returnButton.addEventListener("click", async () => {
    returnButton.disabled = true;
    dispatch({ type: "return-started" });
    try {
      // Closing the editor tab tears down the embedded NPAPI object. A synchronous
      // Application.Quit() can block the renderer and must not gate return to OA.
      await runtimeMessage({ type: "return-to-origin" });
    } catch (error) {
      dispatch({ type: "failed", error: String(error.message || error) });
      returnButton.disabled = false;
    }
  });

  try {
    const handoffId = new URLSearchParams(location.search).get("handoffId");
    if (!handoffId) throw new Error("Editor Handoff ID is missing");
    const response = await runtimeMessage({ type: "consume-editor-handoff", handoffId });
    handoff = response.handoff;
    const gatewayUrl = resolveGateway(handoff.gatewayTemplate, handoff.sourcePath, handoff.handoffId);
    const saveUrl = handoff.oaOrigin + handoff.savePath + "?fileurl=" + encodeURIComponent(handoff.sourcePath);
    document.getElementById("document-title").textContent = handoff.title || handoff.sourcePath;
    dispatch({ type: "handoff-consumed", sourcePath: handoff.sourcePath, gatewayUrl, saveUrl });

    mountWps();
    application = await waitForApplication();
    window.__WPS_APPLICATION__ = application;
    dispatch({ type: "plugin-ready", plugin: { mimeType: MIME_TYPE, applicationName: application.Name } });
    const openResult = application.openDocument(gatewayUrl, false);
    if (openResult === false) throw new Error("WPS openDocument returned false");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (!application.ActiveDocument) throw new Error("WPS reported no ActiveDocument after Gateway open");
    dispatch({ type: "document-opened", result: openResult });
    saveButton.disabled = false;
  } catch (error) {
    dispatch({ type: "failed", error: String(error.message || error) });
  }
})();
