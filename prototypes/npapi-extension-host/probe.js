(async function runProbe() {
  const object = document.getElementById("webwps");
  const mime = navigator.mimeTypes["application/x-wps"];
  const result = {
    capturedAt: new Date().toISOString(),
    href: window.location.href,
    origin: window.location.origin,
    mimeTypeExposed: Boolean(mime),
    pluginName: mime && mime.enabledPlugin ? mime.enabledPlugin.name : null,
    applicationType: null,
    applicationName: null,
    error: null
  };

  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    result.applicationType = typeof object.Application;
    if (result.applicationType === "function" || result.applicationType === "object") {
      result.applicationName = object.Application.Name;
    }
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
  }

  window.__NPAPI_EXTENSION_HOST_RESULT__ = result;
  document.getElementById("result").textContent = JSON.stringify(result, null, 2);
  document.body.dataset.complete = "true";
})();
