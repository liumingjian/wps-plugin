(function installDocumentIdentityGateInterceptor() {
  "use strict";

  const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
  const backgroundReady = new Promise((resolve, reject) => {
    let attempts = 0;
    function ping() {
      attempts += 1;
      chrome.runtime.sendMessage({ type: "prototype-readiness-ping" }, (response) => {
        if (!chrome.runtime.lastError && response?.ok) {
          document.documentElement.dataset.identityGateBackground = "ready";
          resolve();
          return;
        }
        if (attempts >= 40) {
          const error = chrome.runtime.lastError?.message || response?.error || "Extension background did not become ready";
          document.documentElement.dataset.identityGateBackground = "failed";
          document.documentElement.dataset.identityGateError = error;
          reject(new Error(error));
          return;
        }
        setTimeout(ping, 250);
      });
    }
    ping();
  });

  function bytesStartWith(bytes, signature) {
    return signature.every((value, index) => bytes[index] === value);
  }

  function actualFormat(bytes) {
    if (bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "DOC";
    if (!bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "unknown";
    const names = new TextDecoder("latin1").decode(bytes);
    return names.includes("[Content_Types].xml") && names.includes("_rels/.rels") && names.includes("word/document.xml") ? "DOCX" : "malformed-DOCX";
  }

  async function sha256(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  }

  async function readSourceIdentity(sourceUrl, sourcePath) {
    const url = new URL(sourceUrl);
    if (url.origin !== location.origin || url.pathname !== sourcePath) throw new Error("Source URL is no longer same-Origin");
    const response = await fetch(url.href, { credentials: "same-origin", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error(`Authenticated OA source read returned HTTP ${response.status}`);
    const length = Number(response.headers.get("Content-Length") || 0);
    if (length > MAX_SOURCE_BYTES) throw new Error("Authenticated OA source exceeds the prototype size limit");
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_SOURCE_BYTES) throw new Error("Authenticated OA source exceeds the prototype size limit");
    const bytes = new Uint8Array(buffer);
    const format = actualFormat(bytes);
    const expected = sourcePath.toLowerCase().endsWith(".docx") ? "DOCX" : "DOC";
    if (format !== expected) throw new Error(`Authenticated OA source is ${format}, expected ${expected}`);
    return { sourcePath, format, bytes: bytes.byteLength, sha256: await sha256(buffer) };
  }

  function eligibleAnchor(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
    if (!anchor || !anchor.href) return null;
    const url = new URL(anchor.href, location.href);
    if (url.origin !== location.origin || !/\.(doc|docx)$/i.test(url.pathname)) return null;
    return { anchor, url };
  }

  document.addEventListener("click", (event) => {
    const match = eligibleAnchor(event);
    if (!match) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.documentElement.dataset.identityGate = "intercepted";
    backgroundReady.then(() => {
      chrome.runtime.sendMessage({
        type: "intercept-document-link",
        sourceUrl: match.url.href,
        sourcePath: match.url.pathname,
        title: match.anchor.textContent.trim() || match.url.pathname.split("/").pop()
      }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          document.documentElement.dataset.identityGate = "failed";
          document.documentElement.dataset.identityGateError = chrome.runtime.lastError?.message || response?.error || "No extension response";
        } else {
          document.documentElement.dataset.identityGate = "editor-opened";
        }
      });
    }).catch((error) => {
        document.documentElement.dataset.identityGate = "failed";
        document.documentElement.dataset.identityGateError = String(error.message || error);
    });
  }, true);

  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
    if (!request || request.type !== "read-source-identity") return false;
    readSourceIdentity(request.sourceUrl, request.sourcePath)
      .then((identity) => respond({ ok: true, identity }))
      .catch((error) => respond({ ok: false, error: String(error.message || error) }));
    return true;
  });
})();
