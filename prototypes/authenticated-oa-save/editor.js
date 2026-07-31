(async function run() {
  "use strict";

  const OA_ORIGIN = "http://127.0.0.1:49234";
  const SOURCE_PATH = "/UploadFiles/2026/contract.docx";
  const params = new URLSearchParams(location.search);
  const caseName = params.get("case") || "authenticated-open-save";
  const object = document.getElementById("webwps");
  const resultEl = document.getElementById("result");
  const statusEl = document.getElementById("status");
  const result = {
    case: caseName,
    startedAt: new Date().toISOString(),
    origin: location.origin,
    sourcePath: SOURCE_PATH,
    marker: "ticket-38 " + caseName + " " + new Date().toISOString(),
    events: [],
    finalStatus: null,
    complete: false
  };

  window.saveComplete = function saveComplete(type, code, response) {
    result.saveCompleteCallback = { type, code, response };
    render("warn", "收到 WPS 保存回调", JSON.stringify(result.saveCompleteCallback));
  };

  document.getElementById("case-name").textContent = caseName;

  function render(kind, message, detail) {
    result.events.push({ at: new Date().toISOString(), kind, message, detail: detail || null });
    result.finalStatus = { kind, message, detail: detail || null };
    statusEl.dataset.kind = kind;
    statusEl.textContent = message;
    resultEl.textContent = JSON.stringify(result, null, 2);
  }

  function describe(error) {
    return String(error && error.stack ? error.stack : error);
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function application() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (typeof object.Application === "function" || typeof object.Application === "object") {
          return object.Application;
        }
      } catch (_) {
        // The NPAPI object may still be starting.
      }
      await sleep(500);
    }
    throw new Error("WPS Application was not exposed by the NPAPI object");
  }

  function sourceUrl() {
    const cacheBust = encodeURIComponent(result.startedAt);
    if (caseName.indexOf("public-open-protected-save") === 0) {
      return OA_ORIGIN + "/control/contract.docx?case=" + encodeURIComponent(caseName) + "&cb=" + cacheBust;
    }
    return OA_ORIGIN + SOURCE_PATH + "?case=" + encodeURIComponent(caseName) + "&cb=" + cacheBust;
  }

  function saveUrl() {
    return OA_ORIGIN + "/RoadFlow/uploadfiles/OfficeSave?fileurl=" + encodeURIComponent(SOURCE_PATH);
  }

  try {
    const app = await application();
    result.applicationName = app.Name;
    render("warn", "正在打开文档", sourceUrl());
    result.openResult = app.openDocument(sourceUrl(), false);
    await sleep(6000);

    if (!app.ActiveDocument) {
      throw new Error("WPS reported no ActiveDocument after openDocument");
    }

    app.Selection.TypeText(result.marker);
    result.editResult = "marker inserted";
    render("warn", "正在保存", saveUrl());
    result.saveResult = app.ActiveDocument.saveURL_FormData(
      saveUrl(),
      "formId:formeditor;probeCase:" + encodeURIComponent(caseName)
    );
    if (result.saveResult === false) {
      throw new Error("WPS saveURL_FormData returned false");
    }
    await sleep(3000);
    render("ok", "WPS 保存调用已返回", String(result.saveResult));
  } catch (error) {
    result.error = describe(error);
    render("error", caseName.indexOf("save") >= 0 ? "打开或保存失败" : "打开失败", result.error);
  } finally {
    result.completedAt = new Date().toISOString();
    result.complete = true;
    resultEl.textContent = JSON.stringify(result, null, 2);
    window.__AUTHENTICATED_OA_RESULT__ = result;
    window.__QUIT_WPS__ = function quitWps() {
      try {
        object.Application.Quit();
        return true;
      } catch (_) {
        return false;
      }
    };
  }
})();
